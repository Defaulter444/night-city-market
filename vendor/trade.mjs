import {componentSocket, componentHooks, transaction, onceTransaction, requireCustomer, requireProximity, fixerRank, foodTierId, housingItem, textName, lifestyleItem, intrinsicAttack, kindLabel, saleBlocked, fitDialog} from "../scripts/core.mjs";
const marketSocket=componentSocket("trade");
import {
  bundleItemIds,
  categoryLabel,
  documentId,
  eligibleItems,
  isTradeableItem,
  itemAmount
} from "./trade-rules.mjs";

const MODULE_ID = "night-city-market";
const SOCKET_NAME = `module.${MODULE_ID}`;
const MACRO_NAME = "Передача вещей";
const MACRO_ICON = `modules/${MODULE_ID}/assets/choom-trade.webp`;
const LEGACY_MACRO_ICON = "icons/containers/bags/pack-simple-leather-brown.webp";
const REQUEST_TIMEOUT_MS = 15000;
const processedRequests = new Set();
const pendingRequests = new Map();
const transferQueues = new Map();

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function makeId() {
  return foundry?.utils?.randomID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function hasPlayerOwner(actor) {
  return game.users.some((user) => !user.isGM && actor.testUserPermission(user, "OWNER"));
}

function playerCharacters() {
  return game.actors
    .filter((actor) => actor.type === "character" && hasPlayerOwner(actor))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function sourceCharacters() {
  const characters = playerCharacters();
  if (game.user.isGM) return characters;
  return characters.filter((actor) => actor.testUserPermission(game.user, "OWNER"));
}

function actorFromArgument(rawArgs) {
  let args = rawArgs;
  if (Array.isArray(args)) args = args[0] ?? null;

  const reference = typeof args === "string"
    ? args
    : args?.actorUuid ?? args?.actorId ?? args?.uuid ?? args?.id ?? null;

  if (!reference) return null;
  const direct = game.actors.get(String(reference));
  if (direct) return direct;
  try {
    const resolved = fromUuidSync(String(reference));
    if (resolved?.documentName === "Actor") return resolved;
    if (resolved?.actor?.documentName === "Actor") return resolved.actor;
  } catch {
    // A malformed optional argument should not stop the normal actor fallback.
  }
  return null;
}

function initialSourceActor(rawArgs) {
  const allowed = sourceCharacters();
  const requested = actorFromArgument(rawArgs);
  const controlled = canvas?.tokens?.controlled?.[0]?.actor ?? null;
  const assigned = game.user.character ?? null;
  return [requested, controlled, assigned, ...allowed]
    .find((actor) => actor && allowed.some((candidate) => candidate.id === actor.id)) ?? null;
}

function itemPrice(item) {
  const value = Number(item?.system?.price?.market);
  return Number.isFinite(value) && value > 0 ? `${value.toLocaleString()} эб` : "";
}

function renderActorOptions(actors, selectedId) {
  return actors.map((actor) =>
    `<option value="${escapeHtml(actor.id)}"${actor.id === selectedId ? " selected" : ""}>${escapeHtml(actor.name)}</option>`
  ).join("");
}

function renderItemRows(actor) {
  const items = eligibleItems(actor).sort((a, b) => {
    const typeCompare = categoryLabel(a.type).localeCompare(categoryLabel(b.type));
    return typeCompare || a.name.localeCompare(b.name);
  });

  if (!items.length) {
    return `<div class="ct-empty"><i class="fas fa-box-open"></i><b>Нет вещей для передачи.</b><span>Надетая броня и одежда, установленные импланты, образ жизни и встроенные атаки не передаются.</span></div>`;
  }

  return items.map((item) => {
    const amount = itemAmount(item);
    const bundleSize = bundleItemIds(actor, documentId(item)).length;
    const isBundle = bundleSize > 1;
    const quantityControl = amount > 1 && !isBundle
      ? `<label class="ct-qty" title="Количество для передачи"><span>Кол-во</span><input type="number" min="1" max="${amount}" step="1" value="1" data-quantity></label>`
      : `<span class="ct-owned">${isBundle ? `Комплект · ${bundleSize} предметов` : `В наличии · ${amount}`}</span>`;
    const price = itemPrice(item);

    return `
      <article class="ct-item" data-item-id="${escapeHtml(documentId(item))}" data-name="${escapeHtml(item.name.toLocaleLowerCase())}" data-category="${escapeHtml(item.type)}" data-quantity-default="${isBundle ? amount : 1}">
        <img src="${escapeHtml(item.img || "icons/svg/item-bag.svg")}" alt="">
        <div class="ct-item-copy">
          <b>${escapeHtml(item.name)}</b>
          <div><span class="ct-type">${escapeHtml(categoryLabel(item.type))}</span>${price ? `<span>${escapeHtml(price)}</span>` : ""}</div>
        </div>
        ${quantityControl}
        <button type="button" class="ct-send" data-send title="Передать выбранному персонажу"><i class="fas fa-arrow-right"></i><span>Передать</span></button>
      </article>`;
  }).join("");
}

function tradeDialogContent(source, targetId, search = "", category = "all") {
  const sources = sourceCharacters();
  const targets = playerCharacters().filter((actor) => actor.id !== source.id);
  const selectedTarget = targets.some((actor) => actor.id === targetId) ? targetId : (targets[0]?.id ?? "");

  return `
    <div class="choom-trade" data-source-id="${escapeHtml(source.id)}" data-target-id="${escapeHtml(selectedTarget)}" data-category="${escapeHtml(category)}">
      <div class="ct-banner">
        <div><span>ПЕРЕДАЧА ВЕЩЕЙ</span><h2>Передача вещей</h2></div>
        <i class="fas fa-handshake"></i>
      </div>

      <div class="ct-route">
        <label><span>От кого</span><select data-source-select>${renderActorOptions(sources, source.id)}</select></label>
        <i class="fas fa-arrow-right-long"></i>
        <label><span>Кому</span><select data-target-select${targets.length ? "" : " disabled"}>${targets.length ? renderActorOptions(targets, selectedTarget) : `<option>Нет других персонажей игроков</option>`}</select></label>
      </div>

      <div class="ct-tools">
        <label class="ct-search"><i class="fas fa-magnifying-glass"></i><input type="search" placeholder="Поиск вещей для передачи" value="${escapeHtml(search)}" data-search></label>
        <div class="ct-categories" role="group" aria-label="Категория предмета">
          ${[
            ["all", "Все"],
            ["gear", "Снаряжение"],
            ["drug", "Еда / препараты"],
            ["weapon", "Оружие"],
            ["ammo", "Боеприпасы"],
            ["armor", "Броня"],
            ["clothing", "Одежда"],
            ["cyberware", "Киберимпланты"]
          ].map(([value, label]) => `<button type="button" data-filter="${value}" class="${category === value ? "active" : ""}">${label}</button>`).join("")}
        </div>
      </div>

      <div class="ct-notice"><i class="fas fa-shield-halved"></i><span>Надетая броня и одежда, образ жизни и установленные импланты защищены. Ненадетые вещи можно передать. Безоружные и встроенные метательные атаки не передаются.</span></div>
      <section class="ct-list" data-item-list>${renderItemRows(source)}</section>
      <div class="ct-no-match" hidden>По этому запросу ничего не найдено.</div>
    </div>`;
}

function applyItemFilters(root, state) {
  const query = String(root.querySelector("[data-search]")?.value ?? "").trim().toLocaleLowerCase();
  let visible = 0;
  for (const row of root.querySelectorAll(".ct-item")) {
    const matchesSearch = !query || row.dataset.name.includes(query);
    const matchesCategory = state.category === "all" || row.dataset.category === state.category;
    row.hidden = !(matchesSearch && matchesCategory);
    if (!row.hidden) visible += 1;
  }
  const noMatch = root.querySelector(".ct-no-match");
  if (noMatch) noMatch.hidden = visible > 0 || root.querySelectorAll(".ct-item").length === 0;
}

function openTradeDialog({ sourceId = null, targetId = null, search = "", category = "all", args = null } = {}) {
  const sources = sourceCharacters();
  if (!sources.length) {
    return ui.notifications.warn("Нет принадлежащего игроку персонажа Cyberpunk RED для передачи вещей.");
  }

  const source = sources.find((actor) => actor.id === sourceId) ?? initialSourceActor(args) ?? sources[0];
  const targets = playerCharacters().filter((actor) => actor.id !== source.id);
  const state = {
    sourceId: source.id,
    targetId: targets.some((actor) => actor.id === targetId) ? targetId : (targets[0]?.id ?? ""),
    search,
    category
  };

  const dialog = new Dialog({
    title: `Передача вещей — ${source.name}`,
    content: tradeDialogContent(source, state.targetId, state.search, state.category),
    buttons: {
      close: { label: "Закрыть" }
    },
    render: (html) => {
      const root = html[0].querySelector(".choom-trade");
      if (!root) return;

      root.querySelector("[data-source-select]")?.addEventListener("change", (event) => {
        dialog.close();
        openTradeDialog({ sourceId: event.currentTarget.value, targetId: state.targetId });
      });

      root.querySelector("[data-target-select]")?.addEventListener("change", (event) => {
        state.targetId = event.currentTarget.value;
        root.dataset.targetId = state.targetId;
      });

      root.querySelector("[data-search]")?.addEventListener("input", (event) => {
        state.search = event.currentTarget.value;
        applyItemFilters(root, state);
      });

      for (const button of root.querySelectorAll("[data-filter]")) {
        button.addEventListener("click", () => {
          state.category = button.dataset.filter;
          root.dataset.category = state.category;
          for (const peer of root.querySelectorAll("[data-filter]")) peer.classList.toggle("active", peer === button);
          applyItemFilters(root, state);
        });
      }

      for (const button of root.querySelectorAll("[data-send]")) {
        button.addEventListener("click", async () => {
          const row = button.closest("[data-item-id]");
          const selectedTarget = root.querySelector("[data-target-select]")?.value ?? "";
          if (!selectedTarget) return ui.notifications.warn("Сначала выберите другого персонажа игрока.");

          const quantityInput = row.querySelector("[data-quantity]");
          const quantity = quantityInput ? Number(quantityInput.value) : Number(row.dataset.quantityDefault ?? 1);
          button.disabled = true;
          button.innerHTML = `<i class="fas fa-spinner fa-spin"></i><span>Передача</span>`;

          try {
            const response = await requestTransfer({
              sourceActorUuid: source.uuid,
              targetActorUuid: game.actors.get(selectedTarget)?.uuid,
              itemId: row.dataset.itemId,
              quantity
            });
            ui.notifications.info(`${response.quantity > 1 ? `${response.quantity}× ` : ""}${response.itemName} передано: ${response.targetName}.`);
            dialog.close();
            openTradeDialog({
              sourceId: source.id,
              targetId: selectedTarget,
              search: state.search,
              category: state.category
            });
          } catch (error) {
            ui.notifications.error(error.message || "Передача не удалась.");
            button.disabled = false;
            button.innerHTML = `<i class="fas fa-arrow-right"></i><span>Передать</span>`;
          }
        });
      }

      applyItemFilters(root, state);
    }
  }, { width: 790, height: "auto", classes: ["choom-trade-dialog"] });

  return dialog.render(true);
}

function queueTransfer(sourceUuid, targetUuid, operation) {
  const key = [sourceUuid, targetUuid].sort().join("|");
  const previous = transferQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  transferQueues.set(key, next);
  next.finally(() => {
    if (transferQueues.get(key) === next) transferQueues.delete(key);
  });
  return next;
}

function cloneEmbeddedItemData(item) {
  const data = foundry.utils.deepClone(item.toObject());
  delete data._id;
  delete data._stats;
  delete data.folder;
  delete data.ownership;
  delete data.sort;
  return data;
}

function freshEmbeddedId(actor, reserved) {
  let id = makeId();
  while (actor.items.has(id) || reserved.has(id)) id = makeId();
  reserved.add(id);
  return id;
}

function prepareTransferData(sourceItems, targetActor, quantity) {
  const reserved = new Set();
  const idMap = new Map(sourceItems.map((item) => [item.id, freshEmbeddedId(targetActor, reserved)]));

  return sourceItems.map((item, index) => {
    const data = cloneEmbeddedItemData(item);
    data._id = idMap.get(item.id);
    const originalChildren = item.system?.installedItems?.list ?? [];
    if (data.system?.installedItems) {
      data.system.installedItems.list = originalChildren.map((id) => idMap.get(String(id))).filter(Boolean);
    }
    if (index === 0) {
      if (Object.hasOwn(data.system ?? {}, "amount")) data.system.amount = quantity;
      if (Object.hasOwn(data.system ?? {}, "equipped")) data.system.equipped = "carried";
      if (Object.hasOwn(data.system ?? {}, "favorite")) data.system.favorite = false;
    }
    return data;
  });
}

async function compensateFailedTransfer({ sourceActor, targetActor, originals, createdIds, sourceAmount }) {
  try {
    const destinationIds = createdIds.filter((id) => targetActor.items.has(id));
    if (destinationIds.length) await targetActor.deleteEmbeddedDocuments("Item", destinationIds);
  } catch (error) {
    console.error(`${MODULE_ID} | Could not fully roll back destination items`, error);
  }

  try {
    const missing = originals.filter((data) => !sourceActor.items.has(data._id));
    if (missing.length) await sourceActor.createEmbeddedDocuments("Item", missing, { keepId: true });
    const linkRepairs = originals
      .filter((data) => sourceActor.items.has(data._id) && data.system?.installedItems)
      .map((data) => ({
        _id: data._id,
        "system.installedItems": data.system.installedItems
      }));
    if (linkRepairs.length) await sourceActor.updateEmbeddedDocuments("Item", linkRepairs);
    const root = sourceActor.items.get(originals[0]?._id);
    if (root && Object.hasOwn(root.system ?? {}, "amount") && itemAmount(root) !== sourceAmount) {
      await root.update({ "system.amount": sourceAmount });
    }
  } catch (error) {
    console.error(`${MODULE_ID} | Could not fully restore source items`, error);
  }
}

async function ncm_executeTransfer(payload) {
  const requester = game.users.get(payload.userId);
  if (!requester) throw new Error("Пользователь, отправивший запрос, больше не существует.");

  const sourceActor = await fromUuid(payload.sourceActorUuid);
  const targetActor = await fromUuid(payload.targetActorUuid);
  if (sourceActor?.documentName !== "Actor" || targetActor?.documentName !== "Actor") {
    throw new Error("Не найден отправитель или получатель.");
  }
  if (sourceActor.id === targetActor.id) throw new Error("Выберите другого получателя.");
  if (sourceActor.type !== "character" || targetActor.type !== "character") {
    throw new Error("Передавать вещи можно только между персонажами.");
  }
  if (!sourceActor.testUserPermission(requester, "OWNER")) {
    throw new Error(`У вас нет прав владельца: ${sourceActor.name}.`);
  }
  if (!hasPlayerOwner(targetActor)) throw new Error("Получатель не является персонажем игрока.");

  const item = sourceActor.items.get(String(payload.itemId));
  if (!item || !isTradeableItem(item, sourceActor)) {
    throw new Error("Предмет защищён, установлен, недоступен или больше не существует.");
  }

  const available = itemAmount(item);
  const quantity = Math.floor(Number(payload.quantity));
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > available) {
    throw new Error(`Выберите количество от 1 до ${available}.`);
  }

  const bundleIds = bundleItemIds(sourceActor, item.id);
  const isBundle = bundleIds.length > 1;
  if (isBundle && quantity !== available) {
    throw new Error("Предмет с установленными улучшениями передаётся целым комплектом.");
  }

  const sourceItems = bundleIds.map((id) => sourceActor.items.get(id)).filter(Boolean);
  const originals = sourceItems.map((sourceItem) => foundry.utils.deepClone(sourceItem.toObject()));
  const transferData = prepareTransferData(sourceItems, targetActor, quantity);
  const createdIds = transferData.map((data) => data._id);
  const isPartialStack = !isBundle && quantity < available;

  try {
    await targetActor.createEmbeddedDocuments("Item", transferData, { keepId: true });
    if (isPartialStack) {
      await item.update({ "system.amount": available - quantity });
    } else {
      await sourceActor.deleteEmbeddedDocuments("Item", bundleIds);
    }
  } catch (error) {
    await compensateFailedTransfer({
      sourceActor,
      targetActor,
      originals,
      createdIds,
      sourceAmount: available
    });
    throw error;
  }

  try {
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ alias: "Передача вещей" }),
      content: `
        <div class="ct-chat-card">
          <img src="${escapeHtml(item.img || "icons/svg/item-bag.svg")}" alt="">
          <div><span>ПЕРЕДАЧА ЗАВЕРШЕНА</span><b>${escapeHtml(sourceActor.name)} <i class="fas fa-arrow-right"></i> ${escapeHtml(targetActor.name)}</b><p>${quantity > 1 ? `${quantity}× ` : ""}${escapeHtml(item.name)}</p></div>
        </div>`
    });
  } catch (error) {
    console.warn(`${MODULE_ID} | Transfer completed but the chat receipt failed`, error);
  }

  return {
    ok: true,
    itemName: item.name,
    quantity,
    sourceName: sourceActor.name,
    targetName: targetActor.name
  };
}

function sendResponse(payload, response) {
  const message = {
    op: "transfer-response",
    requestId: payload.requestId,
    userId: payload.userId,
    ...response
  };
  marketSocket.emit(SOCKET_NAME, message);
  handleResponse(message);
}

function handleResponse(message) {
  if (message.userId !== game.user.id) return;
  const pending = pendingRequests.get(message.requestId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingRequests.delete(message.requestId);
  if (message.ok) pending.resolve(message);
  else pending.reject(new Error(message.error || "Передача не удалась."));
}

async function processTransfer(payload) {
  if (!payload?.requestId || processedRequests.has(payload.requestId)) return;
  processedRequests.add(payload.requestId);
  try {
    const response = await queueTransfer(payload.sourceActorUuid, payload.targetActorUuid, () => executeTransfer(payload));
    sendResponse(payload, response);
  } catch (error) {
    console.error(`${MODULE_ID} | Trade failed`, error);
    sendResponse(payload, { ok: false, error: error.message || "Передача не удалась." });
  } finally {
    setTimeout(() => processedRequests.delete(payload.requestId), 30000);
  }
}

async function requestTransfer({ sourceActorUuid, targetActorUuid, itemId, quantity = 1 }) {
  if (!sourceActorUuid || !targetActorUuid) throw new Error("Выберите отправителя и получателя.");
  const requestId = makeId();
  const payload = {
    op: "transfer-request",
    requestId,
    userId: game.user.id,
    sourceActorUuid,
    targetActorUuid,
    itemId,
    quantity
  };

  const activeGM = game.users.activeGM;
  if (!activeGM) throw new Error("Для передачи вещей нужен подключённый мастер.");

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("Время ожидания мастера истекло."));
    }, REQUEST_TIMEOUT_MS);
    pendingRequests.set(requestId, { resolve, reject, timeout });

    if (game.user.isGM && activeGM.id === game.user.id) processTransfer(payload);
    else marketSocket.emit(SOCKET_NAME, payload);
  });
}

function bindSocket() {
  marketSocket.on(SOCKET_NAME, (message) => {
    if (!message) return;
    if (message.op === "transfer-response") return handleResponse(message);
    if (message.op !== "transfer-request" || !game.user.isGM) return;
    const activeGM = game.users.activeGM;
    if (activeGM && activeGM.id !== game.user.id) return;
    return processTransfer(message);
  });
}

async function ensureWorldMacro() {
  if (!game.user.isGM) return;
  const activeGM = game.users.activeGM;
  if (activeGM && activeGM.id !== game.user.id) return;
  const existingMacro = game.macros.getName(MACRO_NAME);
  if (existingMacro) {
    if (existingMacro.img === LEGACY_MACRO_ICON) await existingMacro.update({ img: MACRO_ICON });
    return;
  }

  await Macro.create({
    name: MACRO_NAME,
    type: "script",
    scope: "global",
    img: MACRO_ICON,
    command: 'return game.choomTrade.open(typeof args === "undefined" ? null : args);',
    ownership: {
      default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER
    }
  });
}

componentHooks.once("ready", async () => {
  bindSocket();
  game.choomTrade = {
    open: (args = null) => openTradeDialog({ args }),
    requestTransfer,
    eligibleItems
  };
  /* Unified launcher owns navigation. */
  console.log(`${MODULE_ID} | Ready`);
});

componentHooks.on("getActorSheetHeaderButtons", (sheet, buttons) => {
  const actor = sheet?.actor;
  if (!actor || actor.type !== "character" || !actor.testUserPermission(game.user, "OWNER")) return;
  buttons.unshift({
    label: "Передать",
    class: "choom-trade-sheet-button",
    icon: "fas fa-handshake",
    onclick: () => openTradeDialog({ sourceId: actor.id })
  });
});

// Named exports keep the transaction testable without adding anything else to
// the public game.choomTrade API.
export { executeTransfer, prepareTransferData };

async function executeTransfer(payload) { return transaction(() => ncm_executeTransfer(payload)); }
