// Splash page of the desktop shell. It confirms mepmail.dev answers, then
// hands the window to the hosted Correio app. Offline, it keeps a branded
// retry screen instead of the webview's own error page.
const CORREIO_URL = "https://mepmail.dev/mail";
// Any public document works for the probe: an opaque (no-cors) response
// means the host answered; a network error means it did not.
const PROBE_URL = "https://mepmail.dev/manifest.webmanifest";
const PROBE_TIMEOUT_MS = 8000;

const STRINGS = {
  "pt-BR": {
    connecting: "Conectando ao Correio…",
    offlineTitle: "Sem conexão com mepmail.dev",
    offlineHint: "O Correio precisa de internet para abrir. Verifique a conexão e tente de novo.",
    retry: "Tentar de novo",
  },
  en: {
    connecting: "Connecting to Correio…",
    offlineTitle: "No connection to mepmail.dev",
    offlineHint: "Correio needs an internet connection to open. Check your network and try again.",
    retry: "Try again",
  },
};

const language = (navigator.language || "en").toLowerCase().startsWith("pt") ? "pt-BR" : "en";
document.documentElement.lang = language;
for (const node of document.querySelectorAll("[data-i18n]")) {
  const text = STRINGS[language][node.dataset.i18n];
  if (text) node.textContent = text;
}

const shell = document.querySelector(".shell");
const retry = document.getElementById("retry");

function setState(state) {
  shell.dataset.state = state;
}

async function hostAnswers() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetch(PROBE_URL, { mode: "no-cors", cache: "no-store", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

let connecting = false;
async function connect() {
  if (connecting) return;
  connecting = true;
  setState("connecting");
  if (await hostAnswers()) {
    window.location.replace(CORREIO_URL);
    return;
  }
  connecting = false;
  setState("offline");
  retry.focus();
}

retry.addEventListener("click", connect);
window.addEventListener("online", connect);
connect();
