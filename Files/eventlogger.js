const wedtrack = (() => {
  const __ = new (class ___ {
    constructor(
      endpoint,
      sessionId,
      debug = false,
      flushInterval = 500,
      maxBufferSize = 10,
      allowedFields = [],
    ) {
      this.endpoint = endpoint;
      this.sessionId = sessionId;
      this.debug = debug;
      this.flushInterval = flushInterval;
      this.maxBufferSize = maxBufferSize;
      this.allowedFields = new Set(allowedFields);

      this.events = [];
      this.startedAt = performance.now();
      this.cleanupCallbacks = [];
      this.flushTimer = null;
    }

    start() {
      if (!this.sessionId) {
        return this;
      }

      this.track("logger_started", {
        url: this.safeUrl(location.href),
        ua: navigator.userAgent,
        width: window.innerWidth,
        height: window.innerHeight,
      });

      this.listen(document, "click", this.handleClick, true);
      // this.listen(document, "change", this.handleChange, true);
      // this.listen(document, "submit", this.handleSubmit, true);
      this.listen(window, "error", this.handleError);
      this.listen(window, "unhandledrejection", this.handleRejection);
      // this.listen(window, "popstate", this.handleNavigation);
      // this.listen(window, "hashchange", this.handleNavigation);
      // this.listen(document, "visibilitychange", this.handleVisibilityChange);

      // this.instrumentHistory();

      if (this.flushInterval > 0) {
        this.flushTimer = window.setInterval(
          () => void this.flush(),
          this.flushInterval,
        );
      }

      return this;
    }

    stop() {
      for (const cleanup of this.cleanupCallbacks.splice(0)) {
        cleanup();
      }

      if (this.flushTimer) {
        clearInterval(this.flushTimer);
        this.flushTimer = null;
      }

      this.track("logger_stopped");

      return this.flush();
    }

    /**
     * Record a custom event.
     *
     * @param {string} name
     * @param {object} [properties]
     */
    track(name, properties = {}) {
      const event = {
        id: crypto.randomUUID(),
        name,
        timestamp: new Date().toISOString(),
        elapsedMs: Math.round(performance.now() - this.startedAt),
        sessionId: this.sessionId,
        page: this.safeUrl(location.href),
        properties: this.sanitize(properties),
      };

      if (!this.sessionId) {
        return event;
      }

      this.events.push(event);

      if (this.debug) {
        console.debug("[EventLogger]", event);
      }

      if (this.events.length >= this.maxBufferSize) {
        void this.flush();
      }

      return event;
    }

    /**
     * Mark a step as entered.
     */
    step(stepName, properties = {}) {
      return this.track("step", {
        step: stepName,
        ...properties,
      });
    }

    /**
     * Record a failed validation without storing the submitted value.
     */
    validationError(fieldName, message, properties = {}) {
      return this.track("validation_error", {
        field: fieldName,
        message,
        ...properties,
      });
    }

    async flush() {
      if (this.flushPromise) {
        return this.flushPromise;
      }

      if (this.events.length === 0) {
        return;
      }

      const batch = this.events.splice(0);

      this.flushPromise = this.sendBatch(batch)
        .catch((error) => {
          this.events.unshift(...batch);

          if (this.debug) {
            console.warn("[EventLogger] Flush failed", error);
          }
        })
        .finally(() => {
          this.flushPromise = null;

          // Send events that arrived while the previous batch was in flight.
          if (this.events.length >= this.maxBufferSize) {
            void this.flush();
          }
        });

      return this.flushPromise;
    }

    async sendBatch(batch) {
      if (!this.endpoint) {
        return batch;
      }

      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId: this.sessionId,
          sentAt: new Date().toISOString(),
          events: batch,
        }),
        keepalive: true,
      });

      if (!response.ok) {
        throw new Error(`Logging endpoint returned ${response.status}`);
      }
    }

    handleClick = (event) => {
      const element =
        event.target instanceof Element
          ? event.target.closest(
              "button, a, .ct-button, input, select, textarea, [role='button'], [data-log-id]",
            )
          : null;

      if (!element) return;

      this.track("click", {
        element: this.describeElement(element),
        text: this.safeText(element.textContent),
      });
    };

    handleChange = (event) => {
      const element = event.target;

      if (
        !(element instanceof HTMLInputElement) &&
        !(element instanceof HTMLSelectElement) &&
        !(element instanceof HTMLTextAreaElement)
      ) {
        return;
      }

      const fieldName =
        element.name ||
        element.id ||
        element.getAttribute("data-log-id") ||
        "anonymous-field";

      const sensitive =
        element instanceof HTMLInputElement &&
        ["password", "hidden"].includes(element.type);

      this.track("field_changed", {
        field: fieldName,
        inputType:
          element.getAttribute("type") || element.tagName.toLowerCase(),
        value: sensitive
          ? "[REDACTED]"
          : this.allowedFields.has(fieldName)
            ? element.value
            : undefined,
        hasValue: Boolean(element.value),
        valueLength: element.value.length,
      });
    };

    handleSubmit = (event) => {
      const form = event.target;

      if (!(form instanceof HTMLFormElement)) return;

      this.track("form_submitted", {
        form:
          form.getAttribute("data-log-id") ||
          form.name ||
          form.id ||
          "anonymous-form",
        action: this.safeUrl(form.action),
        valid: form.checkValidity(),
      });
    };

    handleError = (event) => {
      this.track("javascript_error", {
        message: event.message,
        filename: this.safeUrl(event.filename),
        line: event.lineno,
        column: event.colno,
        stack: event.error?.stack,
      });
    };

    handleRejection = (event) => {
      const reason = event.reason;

      this.track("unhandled_promise_rejection", {
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
      });
    };

    handleNavigation = () => {
      this.track("navigation", {
        url: this.safeUrl(location.href),
      });
    };

    handleVisibilityChange = () => {
      this.track("visibility_changed", {
        state: document.visibilityState,
      });

      if (document.visibilityState === "hidden") {
        void this.flush();
      }
    };

    instrumentHistory() {
      for (const methodName of ["pushState", "replaceState"]) {
        const original = history[methodName];

        history[methodName] = (...args) => {
          const result = original.apply(history, args);

          this.track("navigation", {
            method: methodName,
            url: this.safeUrl(location.href),
          });

          return result;
        };

        this.cleanupCallbacks.push(() => {
          history[methodName] = original;
        });
      }
    }

    listen(target, eventName, handler, options) {
      target.addEventListener(eventName, handler, options);

      this.cleanupCallbacks.push(() => {
        target.removeEventListener(eventName, handler, options);
      });
    }

    describeElement(element) {
      return {
        tag: element.tagName.toLowerCase(),
        id: element.id || undefined,
        name: element.getAttribute("name") || undefined,
        role: element.getAttribute("role") || undefined,
        logId: element.getAttribute("data-log-id") || undefined,
        type: element.getAttribute("type") || undefined,
        href:
          element instanceof HTMLAnchorElement
            ? this.safeUrl(element.href)
            : undefined,
      };
    }

    safeUrl(value) {
      if (!value) return undefined;

      try {
        const url = new URL(value, location.origin);

        // Remove query parameters and fragments because they often contain
        // email addresses, invitation codes, tokens, or other sensitive data.
        return `${url.origin}${url.pathname}`;
      } catch {
        return undefined;
      }
    }

    safeText(value) {
      if (!value) return undefined;

      return value.replace(/\s+/g, " ").trim().slice(0, 100);
    }

    sanitize(value, seen = new WeakSet()) {
      if (value === null || value === undefined) return value;

      if (typeof value === "string") {
        return value.slice(0, 1000);
      }

      if (typeof value === "number" || typeof value === "boolean") {
        return value;
      }

      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
      }

      if (Array.isArray(value)) {
        return value.slice(0, 100).map((item) => this.sanitize(item, seen));
      }

      if (typeof value === "object") {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);

        const result = {};

        for (const [key, item] of Object.entries(value)) {
          if (
            /password|token|secret|authorization|cookie|email|phone/i.test(key)
          ) {
            result[key] = "[REDACTED]";
          } else {
            result[key] = this.sanitize(item, seen);
          }
        }

        return result;
      }

      return String(value);
    }
  })("/sitemaker/eventlogger.php", window.wedtrack_sessionId).start();

  return function (_) {
    setTimeout(function () {
      try {
        _.call(undefined, __);
      } catch (_) {}
    }, 0);
  };
})();
