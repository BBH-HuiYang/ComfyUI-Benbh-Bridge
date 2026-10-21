// Shared, framework-free schema logic so switching and restoration can be tested.
import { isValidCustomSize, normalizeCustomSizePair, CUSTOM_SIZE_CALIBRATION_ERROR } from "./custom-size.js";
export const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const optionValue = (option) => option && typeof option === "object" && !Array.isArray(option) ? option.value : option;
export const tierId = (tier) => String(tier?.tier_id ?? "");
export const multi = (field) => ["multi-select", "multiselect", "checkbox-group", "checkbox_group"].includes(field.ui_type);
export const isNumericField = field => ["number", "slider"].includes(field.ui_type) || ["integer", "int", "number", "float"].includes(field.type);

export function numericRange(field) {
    const range = field.metadata?.range ?? {};
    return { min: range.min ?? field.min, max: range.max ?? field.max, step: range.step ?? field.step ?? 1 };
}

export function numericIssue(field, value) {
    const label = field.label ?? field.key;
    const { min, max, step } = numericRange(field);
    if (typeof value !== "number" || !Number.isFinite(value)) return `${label}必须是有限数字。`;
    if (!Number.isFinite(step) || step <= 0) return `${label}的步长配置无效。`;
    if (["integer", "int"].includes(field.type) || (step === 1 && Number.isInteger(min ?? 0))) {
        if (!Number.isInteger(value)) return `${label}必须是整数。`;
    }
    if ((min != null && value < min) || (max != null && value > max)) return `${label}超出允许范围。`;
    const steps = (value - (min ?? 0)) / step;
    if (Math.abs(steps - Math.round(steps)) > 1e-9) return `${label}必须符合步长 ${step}。`;
    return "";
}

export function normalizeNumericValue(field, value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    const { min, max, step } = numericRange(field);
    if (!Number.isFinite(step) || step <= 0) return value;
    const clamp = n => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
    const base = min ?? 0;
    return Number(clamp(base + Math.round((clamp(value) - base) / step) * step).toFixed(12));
}

export function defaultValue(field) {
    if (field.default != null) return clone(field.default);
    if (field.default_value != null) return clone(field.default_value);
    if (field.options?.length) return clone(optionValue(field.options.find((o) => o?.is_default) ?? field.options[0]));
    if (field.ui_type === "toggle") return false;
    if (["number", "slider"].includes(field.ui_type)) return numericRange(field).min ?? 0;
    return "";
}

export function getTier(model, selected) {
    const tiers = model?.tiers ?? [];
    const id = selected ?? model?.default_tier_id ?? tierId(tiers.find((t) => t.is_default) ?? tiers[0]);
    return tiers.find((t) => tierId(t) === String(id)) ?? null;
}

export function fieldsFor(model, selectedTier) {
    const tier = getTier(model, selectedTier);
    const rules = tier?.option_exclusions ?? tier?.optionExclusions ?? tier?.metadata?.option_exclusions ?? [];
    return clone(model?.param_schema?.params ?? []).filter((p) => p.key && p.key !== "prompt").map((field) => {
        if (isNumericField(field)) Object.assign(field, numericRange(field));
        if (field.options?.length) {
            const original = field.options;
            field.options = original.filter((o) => !rules.some((r) => r.target_key === field.key && r.target_values?.some((v) => same(v, optionValue(o)))));
            field._hasOptions = true;
        }
        return field;
    });
}

export const CUSTOM_SIZE_OPTION = "__custom_size__";

export function hasCustomSize(model, selectedTier) {
    const tier = getTier(model, selectedTier);
    const fields = model?.param_schema?.params ?? [];
    return tier?.allow_custom_size === true && tier.custom_size_rules?.image_size_tiers?.length > 0 &&
        ["size", "image_size", "aspect_ratio"].every((key) => fields.some((f) => f.key === key && !f.fixed && f.visible !== false && !f.disabled));
}

export function parseCustomSize(value) {
    const match = typeof value === "string" && value.trim().match(/^(\d+)\s*[xX*×]\s*(\d+)$/);
    if (!match) return null;
    const [width, height] = match.slice(1).map(Number);
    return [width, height].every(Number.isSafeInteger) ? { width, height } : null;
}

export function customImageSize(model, selectedTier, pair) {
    if (!pair) return undefined;
    const tiers = [...(getTier(model, selectedTier)?.custom_size_rules?.image_size_tiers ?? [])]
        .filter((t) => Number(t.max_pixels) > 0).sort((a, b) => a.max_pixels - b.max_pixels);
    const matched = tiers.find((t) => pair.width * pair.height <= t.max_pixels) ?? tiers.at(-1);
    const target = String(matched?.value ?? "").trim().toUpperCase();
    const field = fieldsFor(model, selectedTier).find((f) => f.key === "image_size");
    const option = field?.options?.find((o) => [optionValue(o), o?.label].some((v) => String(v ?? "").trim().toUpperCase() === target));
    return option === undefined ? undefined : optionValue(option);
}

export function calibrateCustomSize(model, selectedTier, width, height) {
    const pair = normalizeCustomSizePair(width, height, getTier(model, selectedTier)?.custom_size_rules ?? {});
    if (!pair) return { pair: null, issue: CUSTOM_SIZE_CALIBRATION_ERROR, notice: "" };
    const imageSize = customImageSize(model, selectedTier, pair);
    if (imageSize === undefined) return { pair: null, issue: "修正后的尺寸对应精度在当前线路不可用，请调整尺寸或切换线路。", notice: "" };
    return { pair, imageSize, issue: "", notice: pair.width === width && pair.height === height ? "" :
        `尺寸已校准：${width} × ${height} → ${pair.width} × ${pair.height}` };
}

export function seedCustomSize(model, params) {
    const rules = getTier(model, params.tier_id)?.custom_size_rules ?? {};
    const mapped = rules.image_size_tiers?.find((t) => String(t.value).toUpperCase() === String(params.user_params.image_size).toUpperCase());
    const pixels = Number(mapped?.max_pixels ?? rules.min_pixels ?? 1048576);
    const [w, h] = String(params.user_params.aspect_ratio ?? "1:1").split(":").map(Number);
    const ratio = w > 0 && h > 0 ? w / h : 1;
    return { width: Math.round(Math.sqrt(pixels * ratio)), height: Math.round(Math.sqrt(pixels / ratio)) };
}

export function initialParams(model, saved, resetInvalid = false, customDimensions = true) {
    const tier = getTier(model, saved?.tier_id);
    const chosen = saved?.tier_id ?? tierId(tier);
    const result = { tier_id: chosen, user_params: {} };
    for (const field of fieldsFor(model, chosen)) {
        if (customDimensions && field.key === "size" && resetInvalid && !hasCustomSize(model, chosen)) continue;
        const locked = field.fixed || field.visible === false || field.disabled;
        let value = !locked && Object.hasOwn(saved?.user_params ?? {}, field.key) ? clone(saved.user_params[field.key]) : defaultValue(field);
        if (resetInvalid && field._hasOptions && !field.options.some((o) => same(optionValue(o), value))) {
            value = clone(optionValue(field.options.find((o) => same(optionValue(o), field.default)) ?? field.options[0]));
        }
        if (value !== undefined && value !== "") result.user_params[field.key] = value;
    }
    // Preserve unknown restored fields so both UI and server can report schema changes.
    if (saved && !resetInvalid) {
        for (const [key, value] of Object.entries(saved.user_params ?? {})) {
            if (!Object.hasOwn(result.user_params, key)) result.user_params[key] = clone(value);
        }
    }
    if (typeof result.user_params.size === "string" && !result.user_params.size.trim()) delete result.user_params.size;
    if (customDimensions && result.user_params.size) delete result.user_params.aspect_ratio;
    return result;
}

export function selectionIssue(model, params, customDimensions = true) {
    if (!model) return "请选择模型。";
    if (model.tiers?.length && !getTier(model, params.tier_id)) return "保存的档位已不可用，请重新选择。";
    const fields = fieldsFor(model, params.tier_id);
    const keys = new Set(fields.map((f) => f.key));
    if (Object.keys(params.user_params).some((key) => !keys.has(key))) return "模型参数已变化，请重新选择模型以加载当前参数。";
    const custom = customDimensions && Object.hasOwn(params.user_params, "size");
    if (custom) {
        if (!hasCustomSize(model, params.tier_id)) return "当前线路不支持自定义尺寸，请选择预设比例。";
        const pair = parseCustomSize(params.user_params.size);
        if (!pair || pair.width <= 0 || pair.height <= 0) return "请填写有效的自定义宽高。";
        if (!isValidCustomSize(pair.width, pair.height, getTier(model, params.tier_id).custom_size_rules)) return CUSTOM_SIZE_CALIBRATION_ERROR;
        const imageSize = customImageSize(model, params.tier_id, pair);
        if (imageSize === undefined || !same(imageSize, params.user_params.image_size)) return "自定义尺寸与渲染精度不匹配，请重新填写宽高。";
    }
    for (const field of fields) {
        if (custom && field.key === "aspect_ratio") continue;
        const value = params.user_params[field.key];
        if (field.required && (value == null || value === "")) return `请填写${field.label ?? field.key}。`;
        const picked = multi(field) && Array.isArray(value) ? value : [value];
        if (field._hasOptions && value != null && picked.some((v) => !field.options.some((o) => same(optionValue(o), v)))) {
            return `${field.label ?? field.key}的保存值已不可用，请重新选择。`;
        }
        if (isNumericField(field) && !field._hasOptions && value != null && value !== "") {
            const issue = numericIssue(field, value);
            if (issue) return issue;
        }
        for (const option of field.options ?? []) {
            if (!picked.some((v) => same(v, optionValue(option)))) continue;
            for (const rule of option.mutually_exclusive ?? []) {
                const target = params.user_params[rule.target_key];
                if ((Array.isArray(target) ? target : [target]).some((v) => rule.target_values?.some((blocked) => same(v, blocked)))) {
                    return `${field.label ?? field.key}与${rule.target_key}的选项互斥。`;
                }
            }
        }
    }
    return "";
}
