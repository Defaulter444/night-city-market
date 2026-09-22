import {lifestyleItem, intrinsicAttack} from "../scripts/core.mjs";
export const TRADEABLE_ITEM_TYPES = new Set([
  "gear",
  "drug",
  "weapon",
  "ammo",
  "cyberware",
  "armor",
  "clothing"
]);

export const CATEGORY_LABELS = Object.freeze({
  gear: "Снаряжение",
  drug: "Препараты / еда",
  weapon: "Оружие",
  ammo: "Боеприпасы",
  cyberware: "Киберимпланты",
  armor: "Броня",
  clothing: "Одежда"
});

function collectionToArray(collection) {
  if (Array.isArray(collection)) return collection;
  if (!collection) return [];
  try {
    return Array.from(collection);
  } catch {
    return [];
  }
}

export function documentId(document) {
  return String(document?.id ?? document?._id ?? "");
}

export function itemAmount(item) {
  const raw = Number(item?.system?.amount);
  if (Number.isFinite(raw)) return Math.max(0, Math.floor(raw));
  return 1;
}

function unusedLifestyleItem(item) {
  const name = String(item?.name ?? "").trim();
  if (!name) return false;

  // CPR lifestyle and housing entries in Lt Atlas's world are Gear items named
  // "... 300eb/Month", including the 0eb corporate and street options.
  return /eb\s*\/\s*month\b/i.test(name);
}

function unusedIntrinsicAttack(item) {
  if (item?.type !== "weapon") return false;
  const name = String(item?.name ?? "").trim().toLocaleLowerCase();
  return name === "unarmed" || name === "thrown weapon";
}

export function isEquippedWearable(item) {
  if (item?.type !== "armor" && item?.type !== "clothing") return false;
  const state = item?.system?.equipped;
  return state === true || String(state ?? "").toLocaleLowerCase() === "equipped";
}

export function actorItems(actor) {
  return collectionToArray(actor?.items);
}

export function linkedChildIds(actor) {
  const ids = new Set();
  for (const item of actorItems(actor)) {
    for (const id of item?.system?.installedItems?.list ?? []) {
      if (id) ids.add(String(id));
    }
  }
  return ids;
}

export function installedItemIds(actor) {
  const items = actorItems(actor);
  const byId = new Map(items.map((item) => [documentId(item), item]));
  const installed = new Set();
  const pending = [...(actor?.system?.installedItems?.list ?? [])].map(String);

  while (pending.length) {
    const id = pending.shift();
    if (!id || installed.has(id)) continue;
    installed.add(id);
    const item = byId.get(id);
    for (const childId of item?.system?.installedItems?.list ?? []) {
      if (childId && !installed.has(String(childId))) pending.push(String(childId));
    }
  }

  return installed;
}

export function blockedAttachedItemIds(actor) {
  // Actor-root installation identifies installed foundational cyberware.
  // Every parent link is also blocked so an option cannot be peeled out of a
  // larger, currently uninstalled cyberware assembly as an independent trade.
  return new Set([...installedItemIds(actor), ...linkedChildIds(actor)]);
}

export function isTradeableItem(item, actorOrBlockedIds = null) {
  if (!item || !TRADEABLE_ITEM_TYPES.has(String(item.type))) return false;
  if (itemAmount(item) < 1) return false;
  if (isLifestyleItem(item) || isIntrinsicAttack(item) || isEquippedWearable(item)) return false;

  if (item.type === "cyberware") {
    const blocked = actorOrBlockedIds instanceof Set
      ? actorOrBlockedIds
      : blockedAttachedItemIds(actorOrBlockedIds);
    if (blocked.has(documentId(item))) return false;
    if (item?.system?.core === true) return false;
  }

  return true;
}

export function eligibleItems(actor) {
  const blocked = blockedAttachedItemIds(actor);
  return actorItems(actor).filter((item) => isTradeableItem(item, blocked));
}

export function bundleItemIds(actor, rootId) {
  const byId = new Map(actorItems(actor).map((item) => [documentId(item), item]));
  const collected = [];
  const seen = new Set();
  const pending = [String(rootId)];

  while (pending.length) {
    const id = pending.shift();
    if (!id || seen.has(id)) continue;
    const item = byId.get(id);
    if (!item) continue;
    seen.add(id);
    collected.push(id);
    for (const childId of item?.system?.installedItems?.list ?? []) {
      pending.push(String(childId));
    }
  }

  return collected;
}

export function categoryLabel(type) {
  return CATEGORY_LABELS[type] ?? String(type ?? "Item");
}

export function isLifestyleItem(item) { return lifestyleItem(item); }
export function isIntrinsicAttack(item) { return intrinsicAttack(item); }
