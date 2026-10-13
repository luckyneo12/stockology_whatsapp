const logger = {
  log: (...args) => {
    console.log("[WhatsApp]", ...args);
  },
  error: (...args) => {
    console.error("[WhatsApp ERROR]", ...args);
  },
  warn: (...args) => {
    console.warn("[WhatsApp WARN]", ...args);
  },
  dir: (obj, options) => {
    console.dir(obj, options);
  },
};

module.exports = logger;
