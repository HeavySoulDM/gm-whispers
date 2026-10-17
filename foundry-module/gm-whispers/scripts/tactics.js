/**
 * Тактическая сводка: расстояния, видимость, укрытие, двери, зоны.
 * Считается локально средствами Foundry (те же механизмы, что для зрения и движения токенов),
 * модели уходит компактный текст, а не картинка карты.
 */

import { isDnd5e, stripHtml as stripHtmlSafe } from "./api.js";

const DOOR_STATE = { 0: "закрыта", 1: "открыта", 2: "заперта" };
const NEAR_FT = 60;      // радиус, в котором ищем двери
const SCENE_FT = 120;    // вне боя: кого считать участниками вокруг фокуса

function Sweep() {
  return CONFIG.Canvas.polygonBackends?.sight ?? foundry.canvas.geometry.ClockwiseSweepPolygon;
}

function blocked(a, b, type = "sight") {
  try {
    return !!Sweep().testCollision(a, b, { type, mode: "any" });
  } catch (_) {
    return null; // не удалось проверить
  }
}

function round5(ft) {
  return Math.max(0, Math.round(ft / 5) * 5);
}

function sideOf(doc) {
  const actor = doc.actor;
  if (actor?.hasPlayerOwner && actor.type === "character") return "pc";
  const D = CONST.TOKEN_DISPOSITIONS;
  return { [D.HOSTILE]: "hostile", [D.FRIENDLY]: "friendly", [D.NEUTRAL]: "neutral", [D.SECRET]: "secret" }[doc.disposition] ?? "unknown";
}

/** Центры клеток, занятых токеном (на сетке без клеток — центр токена). */
function cellCenters(token) {
  const doc = token.document;
  const elevation = doc.elevation ?? 0;
  try {
    const offsets = doc.getOccupiedGridSpaceOffsets?.() ?? [];
    if (offsets.length) return offsets.map(o => ({ ...canvas.grid.getCenterPoint(o), elevation }));
  } catch (_) { /* старый API */ }
  return [{ x: token.center.x, y: token.center.y, elevation }];
}

/** Дистанция между ближайшими клетками двух токенов, в единицах сцены (обычно футы). */
function distanceBetween(a, b) {
  let best = Infinity;
  for (const p of cellCenters(a)) {
    for (const q of cellCenters(b)) {
      try {
        const d = canvas.grid.measurePath([p, q]).distance;
        if (d < best) best = d;
      } catch (_) { /* нет измерения */ }
    }
  }
  // Разница высот (полёт, уступы)
  const dz = Math.abs((a.document.elevation ?? 0) - (b.document.elevation ?? 0));
  if (dz && Number.isFinite(best)) best = Math.max(best, dz);
  return Number.isFinite(best) ? best : null;
}

function cellCorners(center, inset = 2) {
  const h = canvas.grid.size / 2 - inset;
  return [
    { x: center.x - h, y: center.y - h, elevation: center.elevation },
    { x: center.x + h, y: center.y - h, elevation: center.elevation },
    { x: center.x - h, y: center.y + h, elevation: center.elevation },
    { x: center.x + h, y: center.y + h, elevation: center.elevation },
  ];
}

/**
 * Укрытие по правилу DMG: из лучшего угла клетки атакующего проводим линии к 4 углам клетки цели.
 * 0 перекрыто — нет; 1–2 — половинное; 3 — три четверти; 4 — полное.
 */
function wallCover(attacker, target) {
  // Берём ближайшую пару клеток (для больших существ), чтобы не делать сотни проверок.
  let pair = null;
  let dmin = Infinity;
  for (const p of cellCenters(attacker)) {
    for (const q of cellCenters(target)) {
      const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
      if (d < dmin) { dmin = d; pair = [p, q]; }
    }
  }
  if (!pair) return null;
  const tCorners = cellCorners(pair[1]);
  let best = 5;
  for (const from of cellCorners(pair[0])) {
    let n = 0;
    for (const to of tCorners) {
      const b = blocked(from, to);
      if (b == null) return null;
      if (b) n += 1;
    }
    if (n < best) best = n;
    if (best === 0) return 0;
  }
  return best === 5 ? null : best;
}

const COVER = { 0: null, 1: "половинное", 2: "половинное", 3: "три четверти", 4: "полное (не прицелиться)" };

/** Существа на линии между двумя токенами дают половинное укрытие. */
function creaturesBetween(a, b, all) {
  const out = [];
  const steps = 24;
  for (const t of all) {
    if (t === a || t === b || t.document.hidden) continue;
    const r = t.bounds;
    for (let s = 1; s < steps; s++) {
      const x = a.center.x + (b.center.x - a.center.x) * (s / steps);
      const y = a.center.y + (b.center.y - a.center.y) * (s / steps);
      if (r.contains(x, y)) { out.push(t.name); break; }
    }
  }
  return out;
}

function cellOf(token) {
  try {
    const o = token.document.getOccupiedGridSpaceOffsets?.()?.[0] ?? canvas.grid.getOffset(token.center);
    return { x: o.j, y: o.i };
  } catch (_) {
    return null;
  }
}

function conditionNames(actor) {
  const conc = CONFIG.specialStatusEffects?.CONCENTRATING ?? "concentrating";
  return [...(actor?.statuses ?? [])].filter(id => id !== conc).map(id => {
    const def = CONFIG.statusEffects?.find(s => s.id === id);
    return def ? game.i18n.localize(def.name ?? def.label ?? id) : id;
  });
}

function isConcentrating(actor) {
  const id = CONFIG.specialStatusEffects?.CONCENTRATING ?? "concentrating";
  return !!actor?.statuses?.has?.(id);
}

function movementText(actor) {
  const m = actor?.system?.attributes?.movement ?? {};
  const units = m.units ?? "фт";
  const names = { walk: "пешком", fly: "полёт", swim: "плавание", climb: "лазание", burrow: "копание" };
  const parts = Object.entries(names).filter(([k]) => Number(m[k]) > 0).map(([k, n]) => `${n} ${m[k]}`);
  if (m.hover) parts.push("парит");
  return parts.length ? `${parts.join(", ")} ${units}` : "";
}

const stripHtml = (html, max = 180) => stripHtmlSafe(html, max);

const ACTIVATION = { bonus: "бонусное", reaction: "реакция", legendary: "легендарное", lair: "логово", minute: "1 мин", hour: "1 ч" };

function activitiesOf(item) {
  const a = item.system?.activities;
  return a?.contents ?? (a ? Object.values(a) : []);
}

/** Строка умения: бонус атаки, урон, СЛ, тип действия, дальность, использования; при detail — начало описания. */
function itemLine(item, { detail = false } = {}) {
  const sys = item.system ?? {};
  const bits = [];
  const acts = activitiesOf(item);
  const act = acts.find(x => x.labels?.toHit) ?? acts.find(x => x.labels?.save) ?? acts[0];
  const at = act?.activation?.type;
  if (ACTIVATION[at]) bits.push(ACTIVATION[at]);
  for (const x of acts) {
    const l = x.labels ?? {};
    const dmg = (l.damage ?? l.damages ?? []).map(d => d.label ?? d.formula).filter(Boolean).join(" + ");
    const part = [l.toHit ? `атака ${l.toHit}` : "", l.save ?? "", dmg].filter(Boolean).join(", ");
    if (part && !bits.includes(part)) bits.push(part);
    if (bits.length > 4) break;
  }
  const r = sys.range ?? {};
  if (r.reach) bits.push(`досягаемость ${r.reach} фт`);
  if (r.value) bits.push(r.long ? `дальность ${r.value}/${r.long} фт` : `дальность ${r.value} фт`);
  const u = sys.uses ?? {};
  const rec = (u.recovery ?? []).find?.(x => x.period === "recharge");
  if (rec?.formula) bits.push(`перезарядка ${rec.formula}–6${u.value === 0 ? " (разряжено)" : ""}`);
  else if (u.max) bits.push(`исп. ${u.value ?? "?"}/${u.max}`);
  let line = bits.length ? `${item.name} (${bits.join("; ")})` : item.name;
  if (detail) {
    const d = stripHtml(sys.description?.value);
    if (d) line += ` — ${d}`;
  }
  return line;
}

function traitList(set, table) {
  return [...(set?.value ?? set ?? [])].map(k => table?.[k]?.label ?? k).filter(Boolean);
}

function spellsSummary(actor, { maxPerLevel = 12 } = {}) {
  const sys = actor.system ?? {};
  const byLevel = new Map();
  for (const item of actor.items) {
    if (item.type !== "spell") continue;
    const prep = item.system?.prepared;
    if (actor.type === "character" && prep === 0 && (item.system?.level ?? 0) > 0) continue; // не подготовлено
    const lvl = item.system?.level ?? 0;
    if (!byLevel.has(lvl)) byLevel.set(lvl, []);
    byLevel.get(lvl).push(item.name);
  }
  const out = [];
  for (const [lvl, names] of [...byLevel.entries()].sort((x, y) => x[0] - y[0])) {
    const slot = lvl ? sys.spells?.[`spell${lvl}`] : null;
    const slotText = slot?.max ? ` [ячейки ${slot.value}/${slot.max}]` : "";
    out.push(`${lvl ? lvl + " круг" : "заговоры"}${slotText}: ${names.slice(0, maxPerLevel).join(", ")}`);
  }
  const dc = sys.attributes?.spell?.dc;
  if (out.length && dc) out.unshift(`СЛ заклинаний ${dc}`);
  return out;
}

function concentrationOn(actor) {
  const id = CONFIG.specialStatusEffects?.CONCENTRATING ?? "concentrating";
  const eff = actor?.effects?.find?.(e => e.statuses?.has?.(id));
  return eff ? eff.name : null;
}

/**
 * Статблок существа. detail=true — для того, за кого думаем: с описаниями умений.
 * Для персонажей игроков — класс, оружие, реакции, подготовленные заклинания.
 */
export function statblock(actor, { detail = false } = {}) {
  if (!actor) return null;
  const sys = actor.system ?? {};
  if (!isDnd5e()) {
    // Другая система: только то, что лежит по общим путям (хиты, КД, скорость); способности модель берёт из описания.
    const hp = sys.attributes?.hp;
    return {
      ac: sys.attributes?.ac?.value,
      hp: hp?.max ? { value: hp.value, max: hp.max } : undefined,
      speed: movementText(actor),
      abilities: [], spells: null, traits: [],
      note: `система ${game.system?.title ?? game.system?.id}: подробный статблок недоступен, см. описание существа`,
    };
  }
  const D5 = CONFIG.DND5E ?? {};
  const out = {
    ac: sys.attributes?.ac?.value,
    speed: movementText(actor),
    cr: actor.type === "character" ? undefined : sys.details?.cr,
    classes: undefined,
    abilities: [],
    spells: spellsSummary(actor, { maxPerLevel: detail ? 12 : 6 }),
    traits: [],
  };
  if (actor.type === "character") {
    try {
      out.classes = Object.values(actor.classes ?? {}).map(c => `${c.name} ${c.system?.levels ?? ""}`.trim()).join(" / ");
    } catch (_) { /* не dnd5e */ }
  }
  const dr = traitList(sys.traits?.dr, D5.damageTypes);
  const di = traitList(sys.traits?.di, D5.damageTypes);
  const dv = traitList(sys.traits?.dv, D5.damageTypes);
  const ci = traitList(sys.traits?.ci, D5.conditionTypes);
  if (dr.length) out.traits.push(`сопротивление: ${dr.join(", ")}`);
  if (di.length) out.traits.push(`иммунитет: ${di.join(", ")}`);
  if (dv.length) out.traits.push(`уязвимость: ${dv.join(", ")}`);
  if (ci.length) out.traits.push(`иммунитет к состояниям: ${ci.join(", ")}`);
  const la = sys.resources?.legact;
  const lr = sys.resources?.legres;
  if (la?.max) out.traits.push(`легендарные действия ${la.value ?? la.max}/${la.max}`);
  if (lr?.max) out.traits.push(`легендарное сопротивление ${lr.value ?? lr.max}/${lr.max}`);
  const conc = concentrationOn(actor);
  if (conc) out.traits.push(`концентрируется: ${conc}`);

  const limit = detail ? 20 : 8;
  for (const item of actor.items) {
    if (item.type === "spell") continue;
    if (!["weapon", "feat", "consumable", "equipment", "tool"].includes(item.type)) continue;
    const acts = activitiesOf(item);
    if (!acts.length) continue;
    // У персонажей — только надетое оружие и то, что срабатывает реакцией/бонусом.
    if (actor.type === "character") {
      const at = acts[0]?.activation?.type;
      if (item.type === "weapon" && !item.system?.equipped) continue;
      if (item.type !== "weapon" && !["reaction", "bonus"].includes(at)) continue;
    }
    out.abilities.push(itemLine(item, { detail }));
    if (out.abilities.length >= limit) break;
  }
  return out;
}

function tokenBasics(token) {
  const doc = token.document;
  const actor = doc.actor;
  const hp = actor?.system?.attributes?.hp;
  return {
    name: token.name,
    side: sideOf(doc),
    cell: cellOf(token),
    size: doc.width > 1 || doc.height > 1 ? `${doc.width}×${doc.height} кл.` : undefined,
    elevation: doc.elevation || undefined,
    hp: hp?.max ? { value: hp.value, max: hp.max } : undefined,
    ac: actor?.system?.attributes?.ac?.value,
    conditions: conditionNames(actor),
    concentrating: isConcentrating(actor) || undefined,
    hidden: doc.hidden || undefined,
  };
}

function darknessText(scene) {
  const d = scene.environment?.darknessLevel ?? scene.darkness ?? 0;
  if (d >= 0.75) return "темно";
  if (d >= 0.35) return "сумерки";
  return "светло";
}

function nearbyDoors(focus) {
  const out = [];
  for (const wall of canvas.walls?.placeables ?? []) {
    const doc = wall.document;
    if (!doc.door) continue;
    const [x0, y0, x1, y1] = doc.c;
    const mid = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
    let d;
    try { d = canvas.grid.measurePath([focus.center, mid]).distance; } catch (_) { continue; }
    if (d > NEAR_FT) continue;
    out.push({ d: round5(d), text: `${doc.door === 2 ? "потайная дверь" : "дверь"}, ${DOOR_STATE[doc.ds] ?? "?"}, ${round5(d)} фт` });
  }
  return out.sort((a, b) => a.d - b.d).slice(0, 8).map(x => x.text);
}

const BEHAVIOR = {
  modifyMovementCost: "трудная местность",
  applyActiveEffect: "накладывает эффект",
  adjustDarknessLevel: "меняет освещённость",
  teleportToken: "телепорт",
  changeLevel: "переход между уровнями",
  defineSurface: "поверхность",
  executeMacro: "срабатывает макрос",
  executeScript: "срабатывает скрипт",
};

function regionsInfo(participants) {
  const out = [];
  for (const region of canvas.scene?.regions ?? []) {
    const kinds = [...new Set((region.behaviors?.contents ?? []).filter(b => !b.disabled).map(b => BEHAVIOR[b.type]).filter(Boolean))];
    const inside = participants.filter(t => {
      try { return region.testPoint({ x: t.center.x, y: t.center.y, elevation: t.document.elevation ?? 0 }); } catch (_) { return false; }
    }).map(t => t.name);
    if (!kinds.length && !inside.length) continue;
    out.push(`«${region.name}»${kinds.length ? " — " + kinds.join(", ") : ""}${inside.length ? "; внутри: " + inside.join(", ") : ""}`);
    if (out.length >= 12) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Путь с обходом стен (поиск по клеткам)                             */
/* ------------------------------------------------------------------ */

const ALLY = { pc: "party", friendly: "party", hostile: "foe", neutral: "neutral", secret: "foe", unknown: "neutral" };

function walkSpeed(actor) {
  const m = actor?.system?.attributes?.movement ?? {};
  return Math.max(Number(m.walk) || 0, Number(m.fly) || 0, Number(m.climb) || 0) || 30;
}

/**
 * Дейкстра по клеткам квадратной сетки от токена focus.
 * Стены — проверкой движения (type "move"), трудная местность — зоны modifyMovementCost (×2),
 * через клетки чужих существ проходить нельзя, через союзников можно (но не останавливаться).
 * Возвращает функцию: стоимость пути (фт) до ближайшей свободной клетки рядом с целью, или null.
 */
function buildPathfinder(focus, participants, maxFt) {
  const grid = canvas.grid;
  if (!grid || grid.isGridless || !grid.isSquare) return null;
  const d = grid.distance;
  const DG = CONST.GRID_DIAGONALS ?? {};
  const diag = grid.diagonals ?? DG.EQUIDISTANT;
  if (diag === DG.ILLEGAL || diag === DG.RECTILINEAR) { /* только по прямой */ }
  const elevation = focus.document.elevation ?? 0;
  const myTeam = ALLY[sideOf(focus.document)];
  const key = (i, j) => `${i},${j}`;

  const blockedCells = new Set();
  const allyCells = new Set();
  for (const t of canvas.tokens.placeables) {
    if (t === focus) continue;
    let offs = [];
    try { offs = t.document.getOccupiedGridSpaceOffsets?.() ?? []; } catch (_) { offs = []; }
    const team = ALLY[sideOf(t.document)];
    const isDefeated = t.document.combatant?.isDefeated;
    for (const o of offs) {
      if (isDefeated) continue;
      (team === myTeam ? allyCells : blockedCells).add(key(o.i, o.j));
    }
  }

  const difficultRegions = (canvas.scene?.regions ?? []).filter(r =>
    (r.behaviors?.contents ?? []).some(b => !b.disabled && b.type === "modifyMovementCost"));
  const terrainCache = new Map();
  const center = (i, j) => ({ ...grid.getCenterPoint({ i, j }), elevation });
  const isDifficult = (i, j) => {
    if (!difficultRegions.length) return false;
    const k = key(i, j);
    if (terrainCache.has(k)) return terrainCache.get(k);
    const c = center(i, j);
    let v = false;
    for (const r of difficultRegions) { try { if (r.testPoint(c)) { v = true; break; } } catch (_) { /* */ } }
    terrainCache.set(k, v);
    return v;
  };
  const edgeCache = new Map();
  const wallBetween = (i0, j0, i1, j1) => {
    const k = `${i0},${j0}>${i1},${j1}`;
    if (edgeCache.has(k)) return edgeCache.get(k);
    const v = blocked(center(i0, j0), center(i1, j1), "move") === true;
    edgeCache.set(k, v);
    return v;
  };

  let start;
  try { start = focus.document.getOccupiedGridSpaceOffsets?.()?.[0]; } catch (_) { /* */ }
  start ??= grid.getOffset(focus.center);

  // Состояние: клетка + чётность диагоналей (для правила 5/10/5).
  const dist = new Map();
  const heap = [[0, start.i, start.j, 0]];
  dist.set(`${start.i},${start.j},0`, 0);
  const cost = new Map(); // клетка -> минимальная стоимость
  const maxCells = Math.ceil(maxFt / d) + 2;
  const rect = canvas.dimensions?.sceneRect ?? null;
  let guard = 0;
  while (heap.length && guard++ < 20000) {
    // простая очередь с приоритетом
    let bi = 0;
    for (let x = 1; x < heap.length; x++) if (heap[x][0] < heap[bi][0]) bi = x;
    const [c, i, j, par] = heap.splice(bi, 1)[0];
    if (c > maxFt) break;
    const ck = key(i, j);
    if (!cost.has(ck) || cost.get(ck) > c) cost.set(ck, c);
    if (dist.get(`${i},${j},${par}`) < c) continue;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      if (!di && !dj) continue;
      const ni = i + di, nj = j + dj;
      if (Math.abs(ni - start.i) > maxCells || Math.abs(nj - start.j) > maxCells) continue;
      const nk = key(ni, nj);
      if (blockedCells.has(nk)) continue;
      if (rect) {
        const cc = grid.getCenterPoint({ i: ni, j: nj });
        if (!rect.contains(cc.x, cc.y)) continue; // за пределами сцены
      }
      const isDiag = di && dj;
      let step = d, npar = par;
      if (isDiag) {
        if (diag === DG.ILLEGAL || diag === DG.RECTILINEAR) continue;
        if (diag === DG.EXACT) step = d * Math.SQRT2;
        else if (diag === DG.APPROXIMATE) step = d * 1.5;
        else if (diag === DG.ALTERNATING_1) { step = par ? 2 * d : d; npar = par ^ 1; }
        else if (diag === DG.ALTERNATING_2) { step = par ? d : 2 * d; npar = par ^ 1; }
      }
      if (isDifficult(ni, nj)) step *= 2;
      const nc = c + step;
      if (nc > maxFt) continue;
      const sk = `${ni},${nj},${npar}`;
      if (dist.has(sk) && dist.get(sk) <= nc) continue;
      if (wallBetween(i, j, ni, nj)) continue;
      dist.set(sk, nc);
      heap.push([nc, ni, nj, npar]);
    }
  }

  return (target) => {
    let offs = [];
    try { offs = target.document.getOccupiedGridSpaceOffsets?.() ?? []; } catch (_) { /* */ }
    if (!offs.length) return null;
    const own = new Set(offs.map(o => key(o.i, o.j)));
    let best = null;
    for (const o of offs) for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const ni = o.i + di, nj = o.j + dj;
      const k = key(ni, nj);
      if (own.has(k) || blockedCells.has(k) || allyCells.has(k)) continue;
      const c = cost.get(k);
      if (c == null) continue;
      // Соседняя клетка за стеной не считается: ударить через стену нельзя.
      if (wallBetween(ni, nj, o.i, o.j)) continue;
      if (best == null || c < best) best = c;
    }
    return best == null ? null : Math.round(best);
  };
}

/** Главная функция: сводка для токена, за которого думаем (по умолчанию — чей ход в бою). */
export function tacticalSnapshot({ focusToken = null } = {}) {
  if (!canvas?.ready || !canvas.scene) return { error: "Сцена не загружена." };
  const combat = game.combat?.started && game.combat.scene?.id === canvas.scene.id ? game.combat : null;

  let focus = focusToken;
  if (!focus && combat?.combatant?.tokenId) focus = canvas.tokens.get(combat.combatant.tokenId);
  if (!focus) focus = canvas.tokens.controlled[0] ?? null;
  if (!focus) return { error: "Нет активного боя на этой сцене. Выдели токен, за который нужно подумать." };

  let participants;
  if (combat) {
    participants = combat.combatants.contents
      .filter(c => c.tokenId && !c.isDefeated)
      .map(c => canvas.tokens.get(c.tokenId))
      .filter(Boolean);
  } else {
    participants = canvas.tokens.placeables.filter(t => {
      if (t === focus) return true;
      try { return canvas.grid.measurePath([focus.center, t.center]).distance <= SCENE_FT; } catch (_) { return false; }
    });
  }
  if (!participants.includes(focus)) participants.unshift(focus);

  const focusEye = { x: focus.center.x, y: focus.center.y, elevation: focus.document.elevation ?? 0 };
  const speed = walkSpeed(focus.actor);
  const maxFt = Math.min(Math.max(speed * 2, 60), 160); // ход + Рывок
  let pathTo = null;
  try { pathTo = buildPathfinder(focus, participants, maxFt); } catch (err) { console.warn("gm-whispers | путь не посчитан", err); }

  const others = participants.filter(t => t !== focus).map(t => {
    const info = tokenBasics(t);
    const sb = statblock(t.actor, { detail: false });
    if (sb) info.statblock = sb;
    if (pathTo) {
      const p = pathTo(t);
      info.walk = p == null ? { ft: null, reach: `дальше ${maxFt} фт пути` } : { ft: p, reach: p <= speed ? "за ход" : p <= speed * 2 ? "только Рывком" : "не дойти" };
    }
    const target = { x: t.center.x, y: t.center.y, elevation: t.document.elevation ?? 0 };
    const d = distanceBetween(focus, t);
    info.distance = d == null ? null : round5(d);
    const sightBlocked = blocked(focusEye, target, "sight");
    info.los = sightBlocked == null ? null : !sightBlocked;
    const cover = wallCover(focus, t);
    info.cover = cover == null ? null : COVER[cover];
    const between = creaturesBetween(focus, t, participants);
    if (between.length) info.through = between;
    const moveBlocked = blocked(focusEye, target, "move");
    if (moveBlocked) info.pathBlocked = true;
    return info;
  }).sort((a, b) => (a.distance ?? 9999) - (b.distance ?? 9999));

  const focusInfo = tokenBasics(focus);
  focusInfo.statblock = statblock(focus.actor, { detail: true });
  focusInfo.speedFt = speed;
  try {
    const sight = focus.document.sight;
    if (sight?.enabled && sight.range) focusInfo.vision = `${sight.range} фт${sight.visionMode && sight.visionMode !== "basic" ? ` (${sight.visionMode})` : ""}`;
  } catch (_) { /* нет зрения */ }

  return {
    scene: {
      name: canvas.scene.navName || canvas.scene.name,
      grid: `${canvas.grid.distance} ${canvas.grid.units || "фт"} на клетку`,
      light: darknessText(canvas.scene),
    },
    round: combat?.round ?? null,
    focus: focusInfo,
    others,
    doors: nearbyDoors(focus),
    regions: regionsInfo(participants),
  };
}
