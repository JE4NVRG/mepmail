/* Provider boundary: views depend on mailbox DTOs, not the fixture store or MIME library. */
const api = async (path, body) => {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined ? {} : { "Content-Type": "application/json", "X-Mailbox-Pilot": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.error === "forbidden"
        ? "Esta identidade não tem permissão para essa ação."
        : "Não foi possível concluir. Tente novamente.",
    );
  return result;
};
const state = {
  mode: "human",
  mailboxes: [],
  box: null,
  rows: [],
  drafts: [],
  folder: "inbox",
  query: "",
  attachmentsOnly: false,
  selected: null,
  epoch: 0,
  busy: false,
  reading: false,
};
// Unsaved text is scoped by demo identity, mailbox and original message, only in memory.
const editors = new Map();
let toastTimer;
const $ = (id) => document.getElementById(id);
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const paths = {
  mail: ["M4 5h16v14H4z", "m4 6 8 7 8-7"],
  inbox: ["M5 4h14l3 11v5H2v-5z", "M2 15h6l2 3h4l2-3h6"],
  edit: ["m15 4 5 5", "m4 20 5-1L21 7l-5-5L4 14z"],
  review: ["M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6z", "m8 12 3 3 5-6"],
  send: ["m3 3 18 9-18 9 4-9z", "M7 12h14"],
  all: ["M4 5h16M4 12h16M4 19h16"],
  search: ["M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0", "m15 15 6 6"],
  paperclip: ["m9 16 8-8a3 3 0 0 0-4-4L4 13a5 5 0 0 0 7 7L21 10", "m7 14 8-8"],
  lock: ["M5 10h14v11H5z", "M8 10V6a4 4 0 0 1 8 0v4", "M12 14v3"],
  shield: ["M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6z", "M12 8v5", "M12 16v.2"],
  refresh: ["M20 8a8 8 0 1 0 1 8", "M20 3v5h-5"],
  close: ["m6 6 12 12M6 18 18 6"],
  "chevron-left": ["m15 5-7 7 7 7"],
  "chevron-right": ["m9 5 7 7-7 7"],
  "chevron-down": ["m5 9 7 7 7-7"],
  "arrow-left": ["M21 12H3m7-7-7 7 7 7"],
  "arrow-right": ["M3 12h18m-7-7 7 7-7 7"],
  "arrow-up-right": ["M6 18 18 6M6 6h12v12"],
  switch: ["M3 7h18l-4-4M21 17H3l4 4"],
  menu: ["M3 6h18M3 12h18M3 18h18"],
  help: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0", "M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4", "M12 17v.2"],
  beaker: ["M9 2h6M10 2v7L4 19a2 2 0 0 0 2 3h12a2 2 0 0 0 2-3L14 9V2", "M7 16h10"],
  moon: ["M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11"],
  sun: [
    "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
    "M12 1v2M12 21v2M1 12h2M21 12h2M4 4l2 2M18 18l2 2M4 20l2-2M18 6l2-2",
  ],
  file: ["M5 2h9l5 5v15H5z", "M14 2v5h5", "M8 12h8M8 16h6"],
  download: ["M12 3v12m-5-5 5 5 5-5", "M4 16v5h16v-5"],
  reply: ["M10 5 3 11l7 6V13c6-1 9 2 11 6 0-8-4-11-11-10z"],
  check: ["m5 12 4 4L19 6"],
};
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.5",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  }))
    svg.setAttribute(key, value);
  for (const data of paths[name] || paths.mail) {
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", data);
    svg.append(path);
  }
  return svg;
}
function hydrateIcons(root = document) {
  for (const placeholder of root.querySelectorAll("[data-icon]"))
    placeholder.replaceWith(icon(placeholder.dataset.icon));
}
function notify(text) {
  $("status").textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $("status").textContent = "";
  }, 6000);
}
function run(action) {
  return () => {
    if (state.busy) return;
    return Promise.resolve()
      .then(action)
      .catch((error) => notify(error.message));
  };
}
function button(text, name, className, action) {
  const node = element("button", undefined, className);
  if (name) node.append(icon(name));
  if (text) node.append(element("span", text));
  if (action) node.onclick = run(action);
  return node;
}
function empty(title, copy, list = false) {
  const node = element("div", undefined, list ? "mm-list-empty" : "mm-empty");
  node.append(
    icon(state.query ? "search" : "mail"),
    element(list ? "strong" : "h2", title),
    element("p", copy),
  );
  return node;
}
function loading() {
  const node = element("div", undefined, "mm-loading");
  node.append(icon("refresh"), element("span", "Abrindo sua caixa…"));
  return node;
}
const cleanSubject = (text) => text.replace(/^(re:\s*)+/i, "");
const normalized = (text) =>
  String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
const displayName = (address) =>
  address
    .split("@")[0]
    .replace(/[._-]/g, " ")
    .replace(/^./, (value) => value.toUpperCase());
const dateLabel = (value) =>
  new Date(value).toLocaleDateString("pt-BR", { day: "numeric", month: "short" });
const timeLabel = (value) =>
  new Date(value).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const editorKey = (original) => `${state.mode}:${state.box.id}:${original}`;

/* Selectors: mailbox → folder → thread. Counts always come from actual DTOs. */
function threads() {
  const grouped = new Map();
  for (const row of [...state.rows].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))) {
    if (!grouped.has(row.threadId))
      grouped.set(row.threadId, { id: row.threadId, rows: [], pending: [] });
    grouped.get(row.threadId).rows.push(row);
  }
  for (const draft of state.drafts.filter((item) => item.status === "draft"))
    grouped.get(draft.threadId)?.pending.push(draft);
  return [...grouped.values()].sort((a, b) =>
    b.rows.at(-1).receivedAt.localeCompare(a.rows.at(-1).receivedAt),
  );
}
function inFolder(thread, folder) {
  if (folder === "drafts" || folder === "review") return thread.pending.length > 0;
  if (folder === "all") return true;
  return thread.rows.some((row) => row.folder === folder);
}
function visibleThreads() {
  const query = normalized(state.query.trim());
  return threads()
    .filter((thread) => inFolder(thread, state.folder))
    .filter(
      (thread) =>
        !state.attachmentsOnly ||
        thread.rows.some((row) => row.attachments) ||
        thread.pending.some((draft) => draft.attachments.length),
    )
    .filter(
      (thread) =>
        !query ||
        normalized(
          thread.rows.map((row) => `${row.subject} ${row.from} ${row.preview}`).join(" ") +
            thread.pending
              .map((draft) => `${draft.text} ${draft.subject} ${draft.to.join(" ")}`)
              .join(" "),
        ).includes(query),
    );
}
function closeSidebar() {
  const wasOpen = $("sidebar").dataset.open === "true";
  $("sidebar").dataset.open = "false";
  $("sidebar").inert = window.matchMedia("(max-width: 760px)").matches;
  $("sidebar").removeAttribute("role");
  $("sidebar").removeAttribute("aria-modal");
  document.querySelector(".mm-main").inert = false;
  $("sidebar-overlay").hidden = true;
  $("menu").setAttribute("aria-expanded", "false");
  if (wasOpen) $("menu").focus();
}
function renderMailboxNavigation() {
  $("box-name").textContent = state.box?.label || "Correio";
  $("box-address").textContent = state.box?.address || "";
  $("mailbox-total").textContent = String(state.mailboxes.length).padStart(2, "0");
  $("profile-name").textContent = state.mode === "agent" ? "Luna" : "Jean";
  $("profile-avatar").textContent = state.mode === "agent" ? "L" : "J";
  $("profile-role").textContent =
    state.mode === "agent" ? "Agente · demonstração" : "Administrador · demonstração";
  $("scope").textContent =
    state.mode === "agent"
      ? "Luna pode ler e preparar rascunhos nesta caixa."
      : "Jean administra esta caixa e aprova as respostas.";
  $("reopen").hidden = state.mode !== "human";
  const nav = $("mailboxes");
  nav.replaceChildren();
  for (const box of state.mailboxes) {
    const item = button("", "", "mm-mailbox", () => {
      state.folder = "inbox";
      state.query = "";
      $("search").value = "";
      closeSidebar();
      return loadMailbox(box.id);
    });
    item.setAttribute("aria-current", box.id === state.box?.id ? "true" : "false");
    item.append(
      element(
        "span",
        box.kind === "agent" ? "L" : "J",
        "mm-avatar" + (box.kind === "agent" ? " mm-avatar-agent" : ""),
      ),
    );
    const label = element("span", undefined, "mm-mailbox-label"),
      title = element("strong", box.label);
    if (box.kind === "agent") title.append(element("span", "AGENTE", "mm-agent-tag"));
    label.append(title, element("small", box.address));
    item.append(label);
    if (box.id === state.box?.id) item.append(element("span", "", "mm-selected-dot"));
    nav.append(item);
  }
  renderFolderNavigation();
}
const folderLabels = {
  inbox: "Entrada",
  drafts: "Rascunhos",
  review: "Para aprovar",
  sent: "Enviados",
  all: "Todas as conversas",
};
function renderFolderNavigation() {
  const nav = $("folders");
  nav.replaceChildren();
  const folders = [
    ["inbox", "inbox"],
    ["drafts", "edit"],
    ["sent", "send"],
    ["all", "all"],
  ];
  if (state.box?.kind === "agent") folders.splice(2, 0, ["review", "review"]);
  for (const [folder, glyph] of folders) {
    const title =
      folder === "review" && state.mode === "agent" ? "Em revisão" : folderLabels[folder];
    const item = button(title, glyph, "mm-folder", () => {
      state.folder = folder;
      closeSidebar();
      renderFolderNavigation();
      renderConversationList(true);
    });
    item.setAttribute("aria-current", state.folder === folder ? "true" : "false");
    const count = threads().filter((thread) => inFolder(thread, folder)).length;
    item.append(element("span", count || "", "mm-folder-count"));
    nav.append(item);
  }
  $("folder-title").textContent =
    state.folder === "review" && state.mode === "agent" ? "Em revisão" : folderLabels[state.folder];
}
function renderConversationList(forceReader = false) {
  const rows = visibleThreads(),
    container = $("messages");
  container.replaceChildren();
  $("thread-count").textContent = rows.length;
  $("list-count-label").textContent = rows.length
    ? `${rows.length} conversa${rows.length === 1 ? "" : "s"}`
    : "";
  $("all-filter").setAttribute("aria-pressed", !state.attachmentsOnly);
  $("attachment-filter").setAttribute("aria-pressed", state.attachmentsOnly);
  for (const thread of rows) {
    const latest = thread.rows.at(-1),
      first = thread.rows[0];
    const item = button("", "", "mm-thread-row", () => openThread(thread.id, true));
    item.dataset.threadId = thread.id;
    item.setAttribute("aria-current", thread.id === state.selected ? "true" : "false");
    const top = element("span", undefined, "mm-row-top");
    top.append(
      element("span", displayName(first.from).slice(0, 1), "mm-row-avatar"),
      element("span", displayName(first.from), "mm-row-sender"),
      element("span", timeLabel(latest.receivedAt), "mm-row-time"),
    );
    item.append(
      top,
      element("strong", cleanSubject(first.subject)),
      element("p", thread.pending.length ? thread.pending.at(-1).text : latest.preview),
    );
    const footer = element("span", undefined, "mm-row-footer");
    if (thread.pending.length) {
      const badge = element("span", "", "mm-row-badge");
      badge.append(icon("review"), element("span", "Aguardando revisão"));
      footer.append(badge);
    } else if (latest.folder === "sent")
      footer.append(icon("check"), element("span", "Resposta simulada"));
    else if (thread.rows.some((row) => row.attachments))
      footer.append(icon("paperclip"), element("span", "Com anexo"));
    footer.append(
      element(
        "span",
        `${thread.rows.length} ${thread.rows.length === 1 ? "mensagem" : "mensagens"}`,
        "mm-row-replies",
      ),
    );
    item.append(footer);
    container.append(item);
  }
  if (!rows.length) {
    const noResults = state.query || state.attachmentsOnly;
    const node = empty(
      noResults
        ? "Nenhuma conversa encontrada."
        : state.folder === "sent"
          ? "Ainda sem respostas enviadas."
          : "Tudo em dia por aqui.",
      noResults
        ? "Tente outro assunto ou remetente, ou limpe os filtros."
        : state.folder === "drafts" || state.folder === "review"
          ? "Seus próximos rascunhos aparecerão aqui."
          : "As mensagens desta pasta aparecerão aqui.",
      true,
    );
    if (noResults)
      node.append(
        button("Limpar filtros", "close", "mm-secondary-button", () => {
          state.query = "";
          state.attachmentsOnly = false;
          $("search").value = "";
          renderConversationList(true);
        }),
      );
    container.append(node);
    state.selected = null;
    state.epoch++;
    $("thread-content").replaceChildren(
      empty(
        "Um pouco de espaço para respirar.",
        "Escolha outra pasta ou ajuste a busca para encontrar suas conversas.",
      ),
    );
    state.reading = false;
    $("app").dataset.reading = "false";
    updateThreadControls();
    return;
  }
  const selected = rows.find((thread) => thread.id === state.selected);
  if (!selected || forceReader)
    openThread((selected || rows[0]).id, state.reading).catch((error) => notify(error.message));
  else updateThreadControls();
}
function updateThreadControls() {
  for (const control of document.querySelectorAll(
    "#folders button, #mailboxes button, #refresh, #search, #all-filter, #attachment-filter, #box-info",
  ))
    control.disabled = state.busy;
  $("refresh").querySelector("svg")?.classList.toggle("mm-busy", state.busy);
  const rows = visibleThreads(),
    index = rows.findIndex((thread) => thread.id === state.selected);
  $("thread-position").textContent = index < 0 ? "" : `${index + 1} de ${rows.length}`;
  $("previous").disabled = state.busy || index <= 0;
  $("next").disabled = state.busy || index < 0 || index >= rows.length - 1;
  const thread = rows[index];
  $("compose").disabled =
    state.busy ||
    !state.box?.permissions.includes("draft") ||
    !thread?.rows.some((row) => row.folder === "inbox") ||
    !!thread?.pending.length;
  $("compose").title = thread?.pending.length
    ? "Já existe um rascunho aguardando revisão"
    : "Responder à conversa selecionada";
}
async function loadMailbox(preferred) {
  const epoch = ++state.epoch;
  state.busy = true;
  updateThreadControls();
  $("messages").replaceChildren(loading());
  $("thread-content").replaceChildren(loading());
  try {
    const data = await api("/api/mailboxes");
    if (epoch !== state.epoch) return;
    const box =
      data.mailboxes.find((item) => item.id === (preferred || state.box?.id)) || data.mailboxes[0];
    if (!box) {
      state.mode = data.mode;
      state.busy = false;
      state.rows = [];
      state.drafts = [];
      state.mailboxes = [];
      state.box = null;
      renderMailboxNavigation();
      renderConversationList();
      return;
    }
    const [messages, drafts] = await Promise.all([
      api(`/api/mailboxes/${box.id}/messages`),
      api(`/api/mailboxes/${box.id}/drafts`),
    ]);
    if (epoch !== state.epoch) return;
    if (state.box?.id !== box.id || state.mode !== data.mode) {
      state.selected = null;
      state.reading = false;
    }
    state.mode = data.mode;
    state.mailboxes = data.mailboxes;
    state.box = box;
    state.rows = messages;
    state.drafts = drafts;
    state.busy = false;
    $("app").dataset.reading = state.reading;
    renderMailboxNavigation();
    renderConversationList(true);
  } catch (error) {
    if (epoch !== state.epoch) return;
    $("messages").replaceChildren(empty("A caixa não abriu.", error.message, true));
    $("thread-content").replaceChildren(empty("Vamos tentar mais uma vez?", error.message));
    throw error;
  } finally {
    if (epoch === state.epoch) {
      state.busy = false;
      updateThreadControls();
    }
  }
}

/* Safe MIME views: every external string is inserted as text. No HTML email execution. */
function attachmentView(attachment, href) {
  const node = element(href ? "a" : "div", undefined, "mm-attachment");
  if (href) {
    node.href = href;
    node.setAttribute("download", attachment.filename);
  }
  const file = element("span", undefined, "mm-attachment-file");
  file.append(icon("file"));
  const label = element("span", undefined, "mm-attachment-name");
  label.append(
    element("strong", attachment.filename),
    element("small", `${attachment.bytes} bytes · ${href ? "baixar" : "incluído na resposta"}`),
  );
  node.append(file, label);
  if (href) node.append(icon("download"));
  return node;
}
function emailView(message, collapsed) {
  const card = element(
    collapsed ? "details" : "div",
    undefined,
    "mm-email-card" + (collapsed ? " mm-email-collapsed" : ""),
  );
  const header = element("div", undefined, "mm-email-header");
  header.append(element("span", displayName(message.from).slice(0, 1), "mm-avatar"));
  const sender = element("div", undefined, "mm-email-sender"),
    title = element("strong", displayName(message.from));
  if (message.folder === "sent") title.append(element("span", "ENVIO SIMULADO", "mm-inline-label"));
  sender.append(
    title,
    element("span", `${message.from} → ${message.to.join(", ") || state.box.address}`),
  );
  if (collapsed)
    sender.append(element("p", message.text.replace(/\s+/g, " ").slice(0, 80), "mm-email-snippet"));
  const date = element("div", dateLabel(message.receivedAt), "mm-email-date");
  date.append(element("small", timeLabel(message.receivedAt)));
  header.append(sender, date);
  if (collapsed) {
    const summary = element("summary");
    summary.append(header, icon("chevron-down"));
    card.append(summary);
  } else card.append(header);
  card.append(element("div", message.text, "mm-email-body"));
  if (message.attachments.length) {
    const files = element("div", undefined, "mm-attachment-list");
    for (const attachment of message.attachments)
      files.append(
        attachmentView(
          attachment,
          `/api/mailboxes/${state.box.id}/messages/${message.id}/attachments/${attachment.id}`,
        ),
      );
    card.append(files);
  }
  return card;
}
function reviewView(draft) {
  const box = state.box,
    card = element("section", undefined, "mm-review-card"),
    header = element("div", undefined, "mm-review-header");
  header.append(
    icon("review"),
    element(
      "strong",
      draft.createdBy === "pilot-agent" ? "Preparado por Luna" : "Rascunho da resposta",
    ),
    element("span", "Aguardando revisão"),
  );
  const route = element("p", undefined, "mm-review-route");
  route.append(
    element("span", "De"),
    element("strong", draft.from),
    element("span", "para"),
    element("strong", draft.to.join(", ")),
  );
  card.append(header, route, element("div", draft.text, "mm-review-body"));
  if (draft.attachments.length) {
    const files = element("div", undefined, "mm-attachment-list");
    for (const attachment of draft.attachments) files.append(attachmentView(attachment));
    card.append(files);
  }
  const actions = element("div", undefined, "mm-review-actions"),
    canSend = box.permissions.includes("send");
  actions.append(
    element(
      "span",
      canSend
        ? "Revise a resposta e os anexos antes de aprovar a simulação."
        : "Jean aprova o envio. Seu rascunho já está salvo.",
    ),
  );
  const approve = button(
    canSend ? "Aprovar e simular envio" : "Aprovação de Jean necessária",
    "check",
    "mm-primary-button",
  );
  approve.disabled = !canSend;
  const errorNode = element("p", "", "mm-composer-error");
  errorNode.setAttribute("role", "alert");
  approve.onclick = run(async () => {
    approve.disabled = true;
    state.busy = true;
    updateThreadControls();
    try {
      await api(`/api/mailboxes/${box.id}/drafts/${draft.id}/send`, {});
      notify("Resposta capturada no piloto. Envio externo não acionado.");
      await loadMailbox(box.id);
    } catch (error) {
      errorNode.textContent = error.message;
      approve.disabled = !canSend;
      throw error;
    } finally {
      state.busy = false;
      updateThreadControls();
    }
  });
  actions.append(approve);
  card.append(actions, errorNode);
  return card;
}
function composerView(original) {
  const box = state.box,
    key = editorKey(original.id),
    stored = editors.get(key) || { text: "", attachments: false };
  const wrapper = element("section"),
    title = element("div", undefined, "mm-composer-title"),
    status = element("span", stored.text ? "Texto preservado · não salvo" : "De " + box.address);
  title.append(icon("reply"), element("strong", "Responder à conversa"), status);
  wrapper.append(title);
  const form = element("form", undefined, "mm-composer");
  const route = element("div", undefined, "mm-composer-route");
  route.append(element("span", "Para"), element("strong", original.replyTo || original.from));
  const text = element("textarea");
  text.value = stored.text;
  text.maxLength = 16000;
  text.setAttribute("aria-label", "Texto da resposta");
  text.placeholder =
    state.mode === "agent"
      ? "Prepare uma resposta para Jean revisar…"
      : "Escreva uma resposta com a sua voz…";
  const footer = element("div", undefined, "mm-composer-footer"),
    label = element("label", undefined, "mm-copy-attachments"),
    check = element("input");
  check.type = "checkbox";
  check.checked = stored.attachments;
  check.disabled = !original.attachments.length;
  label.append(check, element("span", "Incluir os anexos recebidos"));
  const save = button("Salvar rascunho", "edit", "mm-primary-button");
  save.type = "submit";
  const errorNode = element("p", "", "mm-composer-error");
  errorNode.setAttribute("role", "alert");
  const preserve = () => {
    editors.set(key, { text: text.value, attachments: check.checked });
    status.textContent = text.value ? "Texto preservado · não salvo" : "De " + box.address;
  };
  text.oninput = preserve;
  check.onchange = preserve;
  footer.append(label, save);
  form.append(route, text, errorNode, footer);
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (state.busy) return;
    errorNode.textContent = "";
    if (!text.value.trim()) {
      errorNode.textContent = "Escreva uma resposta antes de salvar.";
      text.focus();
      return;
    }
    save.disabled = true;
    text.disabled = true;
    check.disabled = true;
    state.busy = true;
    updateThreadControls();
    try {
      await api(`/api/mailboxes/${box.id}/messages/${original.id}/reply`, {
        text: text.value,
        attachments: check.checked ? original.attachments.map((item) => item.id) : [],
      });
      editors.delete(key);
      notify("Rascunho salvo e pronto para revisão.");
      await loadMailbox(box.id);
    } catch (error) {
      errorNode.textContent = error.message;
      save.disabled = false;
      text.disabled = false;
      check.disabled = !original.attachments.length;
    } finally {
      state.busy = false;
      updateThreadControls();
    }
  };
  const helper = element("p", undefined, "mm-draft-helper");
  helper.append(icon("lock"), element("span", "Salvar um rascunho não envia a mensagem."));
  wrapper.append(form, helper);
  return wrapper;
}
async function openThread(id, reading = false) {
  const thread = visibleThreads().find((item) => item.id === id);
  if (!thread) return;
  const epoch = ++state.epoch,
    box = state.box;
  state.selected = id;
  state.reading = reading;
  $("app").dataset.reading = reading;
  for (const row of $("messages").children)
    row.setAttribute("aria-current", row.dataset.threadId === id ? "true" : "false");
  updateThreadControls();
  $("thread-content").replaceChildren(loading());
  const messages = await Promise.all(
    thread.rows.map((row) => api(`/api/mailboxes/${box.id}/messages/${row.id}`)),
  );
  if (epoch !== state.epoch || state.box.id !== box.id) return;
  const content = $("thread-content");
  content.replaceChildren();
  const heading = element("div", undefined, "mm-conversation-heading");
  heading.append(element("h2", cleanSubject(messages[0].subject)));
  const meta = element("p", undefined, "mm-conversation-meta");
  meta.append(
    element("span", `${messages.length} ${messages.length === 1 ? "mensagem" : "mensagens"}`),
    element("span", "Caixa " + box.address),
  );
  if (thread.pending.length) meta.append(element("span", "Resposta em revisão", "mm-row-badge"));
  heading.append(meta);
  content.append(heading);
  messages.forEach((message, index) =>
    content.append(
      emailView(
        message,
        index < messages.length - 1 || (thread.pending.length && messages.length > 0),
      ),
    ),
  );
  for (const draft of thread.pending) content.append(reviewView(draft));
  const original = messages.findLast((message) => message.folder === "inbox");
  if (original && box.permissions.includes("draft") && !thread.pending.length)
    content.append(composerView(original));
  $("thread-status").replaceChildren(
    icon(thread.pending.length ? "review" : "mail"),
    element(
      "span",
      thread.pending.length ? "Resposta aguardando revisão" : "Conversa · " + box.label,
    ),
  );
  content.scrollTop = 0;
}
async function changeMode(mode) {
  if (state.busy) return;
  state.epoch++;
  state.busy = true;
  state.selected = null;
  state.rows = [];
  state.drafts = [];
  state.query = "";
  state.folder = "inbox";
  $("search").value = "";
  $("identity-dialog").close();
  $("messages").replaceChildren(loading());
  $("thread-content").replaceChildren(loading());
  try {
    await api("/api/session", { mode });
    await loadMailbox(mode === "agent" ? "agent" : undefined);
  } finally {
    state.busy = false;
  }
}
function permissionView() {
  if (!state.box) return;
  const box = state.box,
    content = $("permission-content");
  content.replaceChildren();
  const summary = element("div", undefined, "mm-permission-box"),
    label = element("div");
  label.append(element("strong", box.label), element("p", box.address));
  summary.append(element("span", box.kind === "agent" ? "L" : "J", "mm-avatar"), label);
  content.append(summary);
  for (const [permission, title] of [
    ["read", "Ler mensagens e anexos"],
    ["draft", "Preparar rascunhos"],
    ["send", "Aprovar envios simulados"],
    ["manage", "Administrar acesso"],
  ]) {
    const row = element("div", undefined, "mm-permission-row"),
      value = element("span", "");
    const allowed = box.permissions.includes(permission);
    value.append(
      icon(allowed ? "check" : "lock"),
      element("span", allowed ? "Permitido" : "Sem permissão"),
    );
    row.append(element("span", title), value);
    content.append(row);
  }
  content.append(
    element(
      "p",
      "As permissões pertencem à identidade de demonstração selecionada.",
      "mm-dialog-footnote",
    ),
  );
  $("info-dialog").showModal();
}
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const title = theme === "dark" ? "Ativar tema claro" : "Ativar tema escuro";
  $("theme").replaceChildren(icon(theme === "dark" ? "sun" : "moon"));
  $("theme").setAttribute("aria-label", title);
  $("theme").title = title;
  try {
    localStorage.setItem("ms-theme", theme);
  } catch {}
}
function start() {
  hydrateIcons();
  closeSidebar();
  window.matchMedia("(max-width: 760px)").addEventListener("change", closeSidebar);
  let theme = "dark";
  try {
    theme = localStorage.getItem("ms-theme") === "light" ? "light" : "dark";
  } catch {}
  setTheme(theme);
  $("theme").onclick = () =>
    setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  $("demo").onclick = $("identity").onclick = () => {
    closeSidebar();
    $("identity-dialog").showModal();
  };
  $("help").onclick = () => {
    closeSidebar();
    $("help-dialog").showModal();
  };
  $("box-info").onclick = permissionView;
  for (const close of document.querySelectorAll("[data-close-dialog]"))
    close.onclick = () => close.closest("dialog").close();
  $("human-mode").onclick = run(() => changeMode("human"));
  $("agent-mode").onclick = run(() => changeMode("agent"));
  $("refresh").onclick = run(() => loadMailbox());
  $("reopen").onclick = run(async () => {
    if (state.busy) return;
    $("help-dialog").close();
    await api("/api/reopen", {});
    await loadMailbox();
    notify("Dados recuperados do armazenamento privado.");
  });
  $("search").oninput = (event) => {
    if (state.busy) return;
    state.query = event.target.value;
    renderConversationList();
  };
  $("all-filter").onclick = () => {
    if (state.busy) return;
    state.attachmentsOnly = false;
    renderConversationList();
  };
  $("attachment-filter").onclick = () => {
    if (state.busy) return;
    state.attachmentsOnly = true;
    renderConversationList();
  };
  $("compose").onclick = () => {
    state.reading = true;
    $("app").dataset.reading = "true";
    const textarea = $("thread-content").querySelector("textarea");
    textarea?.scrollIntoView({ block: "center" });
    textarea?.focus();
  };
  for (const [id, offset] of [
    ["previous", -1],
    ["next", 1],
  ])
    $(id).onclick = run(() => {
      const rows = visibleThreads(),
        index = rows.findIndex((thread) => thread.id === state.selected);
      if (rows[index + offset]) return openThread(rows[index + offset].id, state.reading);
    });
  $("back").onclick = () => {
    state.reading = false;
    $("app").dataset.reading = "false";
    $("messages").querySelector('[aria-current="true"]')?.focus();
  };
  $("menu").onclick = () => {
    const open = $("sidebar").dataset.open !== "true";
    if (!open) {
      closeSidebar();
      return;
    }
    $("sidebar").inert = false;
    $("sidebar").setAttribute("role", "dialog");
    $("sidebar").setAttribute("aria-modal", "true");
    document.querySelector(".mm-main").inert = true;
    $("sidebar").dataset.open = open;
    $("sidebar-overlay").hidden = !open;
    $("menu").setAttribute("aria-expanded", open);
    if (open) $("sidebar").querySelector('[aria-current="true"]')?.focus();
  };
  $("sidebar-overlay").onclick = closeSidebar;
  document.addEventListener("keydown", (event) => {
    if ($("sidebar").dataset.open === "true" && event.key === "Tab") {
      const controls = [...$("sidebar").querySelectorAll("button:not([disabled]), a[href]")];
      if (event.shiftKey && document.activeElement === controls[0]) {
        event.preventDefault();
        controls.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === controls.at(-1)) {
        event.preventDefault();
        controls[0]?.focus();
      }
      return;
    }
    if (event.key === "Escape") closeSidebar();
    if (
      document.querySelector("dialog[open]") ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    if (event.key === "/") {
      event.preventDefault();
      $("search").focus();
    }
    if (event.key.toLowerCase() === "r" && !$("compose").disabled) $("compose").click();
  });
  window.addEventListener("beforeunload", (event) => {
    if ([...editors.values()].some((value) => value.text.trim())) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  loadMailbox().catch((error) => notify(error.message));
}
start();
