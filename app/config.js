(function configureAtoll() {
  const host = window.location.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "";

  window.ATOLL_CONFIG = {
    apiUrl: isLocal ? "" : "https://api.atolldb.com",
    fallbackApiUrls: isLocal ? [] : ["https://atoll-control-api.vercel.app"],
    mode: isLocal ? "local" : "hosted"
  };
})();
