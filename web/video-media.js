import { referenceLimit, isReferenceSlot, syncReferenceSlots, sortReferenceInputs, disconnectReferenceSlots, MAX_REFERENCE_INPUTS } from "./media.js";
import { fieldsFor, defaultValue, same } from "./schema.js";

const media = [
    {kind:"image",base:"reference_images",type:"IMAGE",label:"参考图片"},
    {kind:"video",base:"reference_videos",type:"VIDEO",label:"参考视频"},
    {kind:"audio",base:"reference_audios",type:"AUDIO",label:"参考音频"},
];

export function videoMediaLimit(model, params, kind) {
    const definition = model?.task_type_defs?.img2vid;
    if (!definition) return 0;
    const declared = definition.input_media_types;
    if (declared?.length && !declared.includes(kind)) return 0;
    if (!declared?.length && kind !== "image" && !Object.hasOwn(definition.input_media_constraints ?? {}, kind)) return 0;
    if (kind === "image") return referenceLimit(imageContract(model),params);
    const constraint = definition.input_media_constraints?.[kind] ?? {};
    const limits = [Number.isInteger(constraint.max_count) && constraint.max_count >= 0 ? constraint.max_count : 1];
    const fields = new Map(fieldsFor(model,params.tier_id).map(field => [field.key,field]));
    for (const rule of constraint.conditional_max_count_rules ?? []) {
        const field = fields.get(rule.param_key);
        if (!field || !Object.hasOwn(rule,"param_value") || !Number.isInteger(rule.max_count) || rule.max_count <= 0) continue;
        const value = params.user_params[rule.param_key] ?? defaultValue(field);
        if ((Array.isArray(value) ? value : [value]).some(item => same(item,rule.param_value))) limits.push(rule.max_count);
    }
    return Math.min(...limits);
}

export function videoReferenceLinks(node) {
    return node.inputs.filter(input => input.link != null && media.some(item => isReferenceSlot(input,item.base))).map(input => [input.name,input.link]);
}

export function videoReferenceCounts(node) {
    return Object.fromEntries(media.map(item => [item.kind,node.inputs.filter(input => input.link != null && isReferenceSlot(input,item.base)).length]));
}

export function videoMediaInfo(model, params, connected, actual = {}) {
    if (!model) return {issue:"",note:""};
    const counts = Object.fromEntries(media.map(item => [item.kind,Math.max(connected[item.kind] ?? 0,actual?.[item.kind] ?? 0)]));
    const any = Object.values(counts).some(Boolean);
    if (!model.task_type_defs?.[any ? "img2vid" : "txt2vid"]) return {issue:any ? "当前模型不支持参考图片、视频或音频，请断开参考输入或选择其他模型。" : "当前模型需要参考图片、视频或音频，请连接参考输入。",note:""};
    const notes = [];
    for (const item of media) {
        const limit = videoMediaLimit(model,params,item.kind), count = counts[item.kind];
        if (count && limit === 0) return {issue:`当前模型或参数不支持${item.label}，请断开该输入或调整参数。`,note:"已保留原有素材连线。"};
        if (limit != null && count > limit) return {issue:`当前参数最多 ${limit} ${item.kind === "image" ? "张" : "个"}${item.label}，已连接至少 ${count} 个；请减少素材或调整参数。`,note:"已保留原有素材连线。"};
        if (limit !== 0) {
            const prefix = count ? (actual?.[item.kind] ? `已接入 ${actual[item.kind]} ${item.kind === "image" ? "张" : "个"}${item.label}` : `已连接 ${connected[item.kind]} 个${item.label === "参考图片" ? "参考图" : item.label}输入`) : `${item.label}可选`;
            const rules = model.task_type_defs.img2vid?.input_media_constraints?.[item.kind] ?? {};
            notes.push(prefix + (limit == null ? "" : `；当前参数最多 ${limit} ${item.kind === "image" ? "张" : "个"}`) +
                (rules.max_total_duration_seconds > 0 ? `，总时长≤${rules.max_total_duration_seconds}秒` : "") +
                (rules.max_total_size_bytes > 0 ? `，总大小≤${(rules.max_total_size_bytes / 1024 / 1024).toLocaleString("zh-CN",{maximumFractionDigits:2})}MB` : "") +
                (rules.aspect_ratio_check ? "，须匹配画面比例" : "") + "。");
        }
    }
    return {issue:"",note:notes.join("\n")};
}

export function imageContract(model) {
    if (!model) return null;
    const definitions = model.task_type_defs ?? {};
    const translated = {};
    if (definitions.txt2vid) translated.txt2img = definitions.txt2vid;
    if (definitions.img2vid) translated.img2img = definitions.img2vid;
    return { ...model, task_type_defs: Object.keys(translated).length ? translated : { unsupported: {} } };
}

export function videoReferenceInfo(model, params, connected, actualCount, connectedInputs = 0) {
    return videoMediaInfo(model,params,{image:connectedInputs || Number(connected)},actualCount ? {image:actualCount} : {});
}

export function syncVideoReferenceInputs(node, model, params) {
    if (!model) return false;
    let changed = false;
    for (const item of media) {
        const limit = Math.min(MAX_REFERENCE_INPUTS,videoMediaLimit(model,params,item.kind) ?? 1);
        if (syncReferenceSlots(node,{...item,limit})) changed = true;
    }
    return sortReferenceInputs(node, media.map(item => item.base)) || changed;
}

export function disconnectIncompatibleVideoReferences(node, model, params) {
    if (!model) return 0;
    return media.reduce((count, item) => count + disconnectReferenceSlots(node, {
        base: item.base, limit: videoMediaLimit(model, params, item.kind),
    }), 0);
}
