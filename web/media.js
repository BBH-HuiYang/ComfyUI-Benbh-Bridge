import { defaultValue, fieldsFor, same } from "./schema.js";

export const MAX_REFERENCE_INPUTS = 64;
export const isReferenceInput = input => input.name === "reference_images" || /^reference_images_([2-9]|[1-5]\d|6[0-4])$/.test(input.name);

export function referenceInputLimit(model, params) {
    if (!model) return 1;
    if (!supportsTask(model, "img2img")) return 0;
    // Missing catalog limits must not create dozens of speculative inputs.
    return Math.min(MAX_REFERENCE_INPUTS, referenceLimit(model, params) ?? 1);
}

export function syncReferenceInputs(node, model, params) {
    if (!model) return false;
    const limit = referenceInputLimit(model, params);
    const changed = syncReferenceSlots(node, { limit, base: "reference_images", type: "IMAGE", label: "参考图片" });
    return sortReferenceInputs(node, ["reference_images"]) || changed;
}

export function isReferenceSlot(input, base) {
    if (input.name === base) return true;
    if (!input.name.startsWith(base + "_")) return false;
    return /^([2-9]|[1-5]\d|6[0-4])$/.test(input.name.slice(base.length + 1));
}

export function sortReferenceInputs(node, bases) {
    const group = input => bases.findIndex(base => isReferenceSlot(input, base));
    const ordinal = input => input.name === bases[group(input)] ? 1 : Number(input.name.split("_").at(-1));
    const references = node.inputs.filter(input => group(input) >= 0)
        .sort((a, b) => group(a) - group(b) || ordinal(a) - ordinal(b));
    let cursor = 0;
    // Leave prompt/widget and other non-reference inputs in their original positions.
    const ordered = node.inputs.map(input => group(input) >= 0 ? references[cursor++] : input);
    if (ordered.every((input, index) => input === node.inputs[index])) return false;
    node.inputs.splice(0, node.inputs.length, ...ordered);
    for (let index = 0; index < node.inputs.length; index++) {
        const input = node.inputs[index];
        if (input.link == null) continue;
        const link = node.getInputLink?.(index) ?? node.graph?.getLink?.(input.link);
        if (link) link.target_slot = index;
    }
    if (node.graph) node.graph._version++;
    node.setDirtyCanvas?.(true, true);
    return true;
}

export function disconnectReferenceSlots(node, {base, limit}) {
    if (!Number.isInteger(limit) || limit < 0) return 0;
    const ordinal = input => input.name === base ? 1 : Number(input.name.slice(base.length + 1));
    const excess = node.inputs.filter(input => isReferenceSlot(input, base) && input.link != null)
        .sort((a, b) => ordinal(a) - ordinal(b)).slice(limit);
    let disconnected = 0;
    for (const input of excess) {
        // Native disconnection updates the source output and graph link table too.
        // Resolve the index again because connection callbacks may change slots.
        const index = node.inputs.indexOf(input);
        if (index < 0 || input.link == null) continue;
        node.disconnectInput(index);
        if (input.link == null) disconnected++;
    }
    return disconnected;
}

export function disconnectIncompatibleReferences(node, model, params) {
    if (!model) return 0;
    const limit = supportsTask(model, "img2img") ? referenceLimit(model, params) : 0;
    return disconnectReferenceSlots(node, {base: "reference_images", limit});
}

export function syncReferenceSlots(node, {limit, base, type, label}) {
    const matches = input => isReferenceSlot(input, base);
    const connected = node.inputs.filter(input => matches(input) && input.link != null);
    const connectedNames = new Set(connected.map(input => input.name));
    // Keep the existing connected slots (including links beyond a new cap).
    // Offer just one vacant slot, reusing the lowest available stable name.
    let vacantName = null;
    if (connected.length < limit) {
        for (let index = 1; index <= limit; index++) {
            const name = index === 1 ? base : `${base}_${index}`;
            if (!connectedNames.has(name)) { vacantName = name; break; }
        }
    }
    let changed = false;
    for (let index = node.inputs.length - 1; index >= 0; index--) {
        const input = node.inputs[index];
        if (matches(input) && input.name !== vacantName && input.link == null) {
            node.removeInput(index);
            changed = true;
        }
    }
    if (vacantName && !node.inputs.some(input => input.name === vacantName)) {
        node.addInput(vacantName, type);
        changed = true;
    }
    for (const input of node.inputs.filter(matches)) {
        const index = input.name === base ? 1 : Number(input.name.split("_").at(-1));
        input.label = input.localized_name = index === 1 ? `${label}（可选）` : `${label} ${index}（可选）`;
    }
    return changed;
}

export function supportsTask(model, taskType) {
    const definitions = model?.task_type_defs;
    return definitions && Object.keys(definitions).length ? Object.hasOwn(definitions, taskType) : taskType === "txt2img";
}

export function referenceLimit(model, params) {
    const definition = model?.task_type_defs?.img2img ?? {};
    const constraint = definition.input_media_constraints?.image ?? {};
    const count = (value, minimum = 1) => Number.isInteger(value) && value >= minimum ? value : null;
    const base = count(constraint.max_count) ?? count(definition.max_images, 0);
    const limits = base == null ? [] : [base];
    const fields = new Map(fieldsFor(model, params.tier_id).map(field => [field.key, field]));
    for (const rule of constraint.conditional_max_count_rules ?? []) {
        if (!rule || !fields.has(rule.param_key) || !Object.hasOwn(rule, "param_value")) continue;
        const value = params.user_params[rule.param_key] ?? defaultValue(fields.get(rule.param_key));
        const maximum = count(rule.max_count);
        if (maximum != null && (Array.isArray(value) ? value : [value]).some(item => same(item, rule.param_value))) limits.push(maximum);
    }
    return limits.length ? Math.min(...limits) : null;
}

export function referenceInfo(model, params, connected, actualCount, connectedInputs = 0) {
    if (!model) return { issue: "", note: "" };
    if (!supportsTask(model, connected ? "img2img" : "txt2img")) {
        return { issue: connected ? "当前模型不支持参考图片，请断开图片输入或选择其他模型。" : "当前模型需要参考图片，请连接图片输入。", note: "" };
    }
    if (!supportsTask(model, "img2img")) return { issue: "", note: "" };
    const limit = referenceLimit(model, params);
    if (connected && limit === 0) return { issue: "当前参数不支持参考图片，请断开图片输入或调整参数。", note: "" };
    if (limit != null && Math.max(actualCount ?? 0, connectedInputs) > limit) {
        return { issue: `当前参数最多 ${limit} 张参考图片，已连接至少 ${Math.max(actualCount ?? 0, connectedInputs)} 张；请减少参考图片或调整参数。`, note: "已保留原有参考图连线。" };
    }
    const prefix = connected ? (actualCount ? `已接入 ${actualCount} 张参考图片` : `已连接 ${connectedInputs} 个参考图输入`) : "参考图片可选";
    return { issue: "", note: prefix + (limit == null ? "。" : `；当前参数最多 ${limit} 张。`) };
}

export function formatQuote(quote) {
    const payable = Number(quote?.payable_points);
    const original = Number(quote?.original_points);
    const rate = Number(quote?.discount_rate);
    if (![payable, original, rate].every(Number.isFinite) || payable < 0 || original < 0 || rate <= 0 || rate > 1) throw new Error("平台报价数据不完整");
    const format = value => value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
    return `预计消耗：${format(payable)} 积分` + (payable < original ? `（原价 ${format(original)}，${format(rate * 10)} 折）` : "");
}
