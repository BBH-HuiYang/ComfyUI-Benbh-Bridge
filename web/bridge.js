import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { ComfyWidgets } from "../../../scripts/widgets.js";
import { clone, same, optionValue, tierId, multi, defaultValue, getTier, fieldsFor, initialParams, selectionIssue,
    CUSTOM_SIZE_OPTION, hasCustomSize, parseCustomSize, calibrateCustomSize, seedCustomSize, isNumericField, normalizeNumericValue } from "./schema.js";
import { migrateNode, migrateGraph, pruneDefinition, pruneWidgets } from "./migration.js";
import { createDynamicPanel } from "./dynamic-panel.js";
import { referenceInfo, formatQuote, isReferenceInput, syncReferenceInputs, disconnectIncompatibleReferences } from "./media.js";
import { createRuntimeStatus } from "./runtime.js";

const CLASS = "BenbhImageGenerate";
const pendingSaves = new Set();
let saveTimer;

function flushWorkflowSave() {
    clearTimeout(saveTimer);
    const root = app.rootGraph ?? app.graph;
    const active = [...pendingSaves].some((node) => node.graph && (node.graph.rootGraph ?? node.graph) === root);
    pendingSaves.clear();
    if (!active) return;
    // Use ComfyUI's own change tracking and persistence so workflow tabs and
    // its persistence setting keep their normal behavior.
    const tracker = app.extensionManager?.workflow?.activeWorkflow?.changeTracker;
    if (typeof tracker?.checkState === "function" && !tracker.changeCount) tracker.checkState();
    else api.dispatchEvent(new CustomEvent("graphChanged"));
}

function scheduleWorkflowSave(node) {
    if (!node.graph) return;
    pendingSaves.add(node);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushWorkflowSave, 75);
}

const chain = (target, name, fn) => {
    const original = target[name];
    target[name] = function (...args) {
        const result = original?.apply(this, args);
        fn.apply(this, args);
        return result;
    };
};

function hidden(widget) {
    widget.type = "converted-widget";
    widget.computeSize = () => [0, -4];
    widget.hidden = true;
    // Vue Nodes checks options.hidden; widget.hidden only hides the canvas UI.
    // Otherwise its legacy-widget canvas can cover visible controls below it.
    widget.options = { ...widget.options, hidden: true };
    if (widget.inputEl) widget.inputEl.style.display = "none";
}

function transient(widget) {
    widget.serialize = false;
    widget.options = { ...widget.options, serialize: false };
    return widget;
}

function resize(node) {
    const size = node.computeSize();
    node.setSize([Math.max(370, node.size[0], size[0]), Math.max(330, size[1])]);
    app.graph?.setDirtyCanvas(true, true);
}

function parseParams(value) {
    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        return { tier_id: parsed.tier_id, user_params: parsed.user_params ?? {} };
    } catch { return null; }
}

function ensureReferenceInput(node) {
    const input = node.inputs?.find(input => input.name === "reference_images") ?? node.addInput("reference_images", "IMAGE");
    input.label = input.localized_name = "参考图片（可选）";
    for (const slot of node.inputs.filter(isReferenceInput)) {
        if (slot.name !== "reference_images") slot.label = slot.localized_name = `参考图片 ${slot.name.split("_").at(-1)}（可选）`;
    }
}

export function setupBridge(node, options = {}) {
    const customDimensions = options.customDimensions !== false;
    const initParams = (model, saved, reset = false) => initialParams(model, saved, reset, customDimensions);
    const paramIssue = (model, params) => selectionIssue(model, params, customDimensions);
    pruneWidgets(node);
    ensureReferenceInput(node);
    const byName = (name) => node.widgets.find((w) => w.name === name);
    const state = node._benbh = {
        model: null, models: [], params: { tier_id: "", user_params: {} }, epoch: 0,
        modelId: byName("model_id"), paramsWidget: byName("params_json"),
        prompt: byName("prompt"), dynamic: [], message: "正在加载模型…",
        quoteReady: false, authenticated: false, quoteText: "", quoteEpoch: 0, quoteKey: null,
    };
    hidden(state.modelId);
    hidden(state.paramsWidget);
    state.prompt.label = "提示词";
    // Canvas uses DOM layout hooks; Vue renders its own textarea from options.
    // Reserve the space in both layouts so controls below cannot overlap it.
    state.prompt.options = { ...state.prompt.options,
        getMinHeight: () => 160, getHeight: () => 160,
        style: { minHeight: "140px" }, rows: 8,
    };
    state.prompt.computeSize = () => [360, 160];
    state.prompt.inputEl?.style.setProperty("--comfy-widget-min-height", "160px");
    const promptCallback = state.prompt.callback;
    state.prompt.callback = function (...args) {
        const result = promptCallback?.apply(this, args);
        scheduleWorkflowSave(node);
        return result;
    };
    const promptInput = () => scheduleWorkflowSave(node);
    state.prompt.inputEl?.addEventListener("input", promptInput);
    state.disposePersistence = () => {
        pendingSaves.delete(node);
        state.prompt.inputEl?.removeEventListener("input", promptInput);
        state.runtime?.dispose();
        api.removeEventListener("reconnecting", onDisconnect);
        api.removeEventListener("reconnected", onReconnect);
    };

    state.selector = transient(node.addWidget("combo", "选择模型", "加载中…", (label) => {
        const model = state.models.find((m) => modelLabel(m) === label);
        if (model) { chooseModel(model, false, true); scheduleWorkflowSave(node); }
    }, { values: ["加载中…"] }));
    state.panel = createDynamicPanel(node, app);
    function panelControl(widget) {
        if (state.panel) {
            widget.options.hidden = true;
            widget.hidden = true;
            widget.computeSize = () => [0, -4];
        }
        return widget;
    }
    panelControl(state.selector);
    const renderPanel = () => state.panel?.render([state.selector, ...state.dynamic]);
    renderPanel();
    const status = ComfyWidgets.STRING(node, "平台状态", ["STRING", { multiline: true }], app).widget;
    state.status = transient(status);
    status.inputEl.readOnly = true;
    status.inputEl.style.fontSize = "12px";
    status.inputEl.style.color = "var(--input-text)";
    status.inputEl.style.opacity = "0.85";
    status.inputEl.setAttribute("aria-label", "Benbh 平台状态");
    status.computeSize = () => [360, 75];

    function modelName(model) { return String(model.name || "未命名模型").replaceAll("/", " | "); }
    function modelLabel(model) {
        const name = modelName(model);
        const matches = state.models.filter((m) => modelName(m) === name);
        if (matches.length <= 1) return name;
        const index = matches.findIndex((m) => String(m.id) === String(model.id));
        return index < 0 ? name : `${name}（${index + 1}）`;
    }
    function show(message) {
        state.message = message;
        const media = mediaInfo();
        const issue = state.model ? paramIssue(state.model, state.params) || media.issue : "";
        status.value = [state.quoteText, state.runtime?.line(message) ?? message, state.selectionNotice, media.note, state.sizeNotice, issue ? `请核对：${issue}` : ""].filter(Boolean).join("\n");
        renderPanel();
        app.graph?.setDirtyCanvas(true, false);
    }
    state.show = show;
    function runtimeIdentity() {
        node.properties ??= {};
        if (!node.properties.benbh_runtime_key) {
            node.properties.benbh_runtime_key = crypto.randomUUID();
            scheduleWorkflowSave(node);
        }
        const root = node.graph?.rootGraph ?? app.rootGraph ?? app.graph;
        return { task_family: options.taskFamily ?? "image", workflow_id: String(root?.id ?? ""),
            node_id: String(node.id), node_key: node.properties.benbh_runtime_key };
    }
    state.runtime = createRuntimeStatus({ identity: runtimeIdentity,
        async fetchStatus(identity, signal) {
            const response = await api.fetchApi(`/benbh-bridge/runtime?${new URLSearchParams(identity)}`, {signal, cache:"no-store"});
            if (!response.ok) throw new Error(`运行状态不可用（HTTP ${response.status}）`);
            return (await response.json()).status;
        },
        onChange: () => show(state.message), onSnapshot: detail => state.receiveStatus(detail),
    });
    state.receiveStatus = detail => {
        if (detail.timing && !state.runtime.accept(detail)) return;
        if (detail.quote && ((options.taskFamily === "video") || state.imageConnected()) &&
            String(detail.model_id) === String(state.model?.id) && detail.params_json === state.paramsWidget.value) {
            try { state.quoteText = formatQuote(detail.quote); state.referenceCount = detail.reference_count; state.referenceCounts = detail.reference_counts ?? {image:detail.reference_count}; }
            catch { state.quoteText = "预计消耗：平台报价数据不完整"; }
        }
        show(detail.message ?? "");
    };
    const onDisconnect = () => state.runtime.setConnected(false);
    const onReconnect = () => { state.runtime.setConnected(true); state.runtime.restore(); };
    api.addEventListener("reconnecting", onDisconnect);
    api.addEventListener("reconnected", onReconnect);
    function imageConnected() { return node.inputs?.some(input => isReferenceInput(input) && input.link != null) ?? false; }
    state.imageConnected = imageConnected;
    function mediaInfo() {
        if (options.mediaInfo) return options.mediaInfo(state.model,state.params,options.referenceCounts(node),state.referenceCounts);
        const count = node.inputs.filter(input => isReferenceInput(input) && input.link != null).length;
        return (options.referenceInfo ?? referenceInfo)(state.model, state.params, count > 0, state.referenceCount, count);
    }
    function syncReferences() {
        if ((options.syncReferenceInputs ?? syncReferenceInputs)(node, state.model, state.params)) resize(node);
    }

    function scheduleQuote() {
        if (!state.quoteReady || !state.model) return;
        const body = { model_id: String(state.model.id), params: clone(state.params) };
        const connected = imageConnected();
        if (connected) body.reference_count = node.inputs.filter(input => isReferenceInput(input) && input.link != null).length;
        if (options.referenceCounts) {
            const counts = options.referenceCounts(node);
            body.reference_count = counts.image;
            body.video_reference_count = counts.video;
            body.audio_reference_count = counts.audio;
        }
        const key = JSON.stringify({ ...body, reference_images: options.referenceLinks ? options.referenceLinks(node) : node.inputs.filter(input => isReferenceInput(input) && input.link != null).map(input => [input.name, input.link]) });
        if (key === state.quoteKey) return;
        state.quoteKey = key;
        state.referenceCount = null;
        state.referenceCounts = null;
        const epoch = ++state.quoteEpoch;
        clearTimeout(state.quoteTimer);
        state.quoteController?.abort();
        if (!state.authenticated || paramIssue(state.model, state.params) || mediaInfo().issue) {
            state.quoteText = state.authenticated ? "预计消耗：请先核对参数" : "预计消耗：配置 API Key 后可计算";
            show(state.message);
            return;
        }
        state.quoteText = "预计消耗：计算中…";
        show(state.message);
        const controller = state.quoteController = new AbortController();
        state.quoteTimer = setTimeout(async () => {
            try {
                const response = await api.fetchApi(options.quoteUrl ?? "/benbh-bridge/quote", {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body), signal: controller.signal, cache: "no-store",
                });
                if ([404, 405].includes(response.status)) {
                    throw new Error(`当前 ComfyUI 服务尚未加载报价接口，请重启当前服务后刷新页面（HTTP ${response.status}）`);
                }
                let data;
                try { data = await response.json(); }
                catch { throw new Error(`报价接口返回格式异常（HTTP ${response.status}），请检查当前服务或代理是否正常`); }
                if (epoch !== state.quoteEpoch) return;
                if (!response.ok) throw new Error(data?.error ?? `读取报价失败（HTTP ${response.status}）`);
                state.quoteText = formatQuote(data?.quote);
            } catch (error) {
                if (epoch !== state.quoteEpoch || error.name === "AbortError") return;
                state.quoteText = `预计消耗：暂无法获取\n${error.message}`;
            }
            show(state.message);
        }, 200);
    }

    function sync() {
        syncReferences();
        state.paramsWidget.value = JSON.stringify(state.params);
        if (state.model) {
            node.properties ??= {};
            node.properties.benbh_bridge = { version: 1, model_snapshot: clone(state.model) };
        }
        scheduleQuote();
    }
    state.paramsWidget.serializeValue = () => { sync(); return state.paramsWidget.value; };

    function clearDynamic() {
        for (const widget of state.dynamic) {
            widget.onRemove?.();
            const index = node.widgets.indexOf(widget);
            if (index >= 0) node.widgets.splice(index, 1);
        }
        state.dynamic = [];
        state.sizeWidgets = null;
        state.autoPrecision = null;
    }

    function setCustomSize(width, height) {
        const result = calibrateCustomSize(state.model, state.params.tier_id, Number(width), Number(height));
        const pair = result.pair ?? { width, height };
        state.params.user_params.size = `${pair.width}x${pair.height}`;
        delete state.params.user_params.aspect_ratio;
        if (result.pair) state.params.user_params.image_size = result.imageSize;
        state.sizeNotice = result.notice;
        state.lastSize = pair;
        if (state.sizeWidgets) {
            state.sizeWidgets.width.value = pair.width;
            state.sizeWidgets.height.value = pair.height;
        }
        if (state.autoPrecision) {
            const { widget, field } = state.autoPrecision;
            const value = state.params.user_params.image_size;
            widget.value = String(field.options?.find((o) => same(optionValue(o), value))?.label ?? value);
            widget.name = `${field.label ?? field.key}（自动）：${widget.value}`;
        }
    }

    function restoreCustomSize() {
        state.sizeNotice = "";
        state.sizeWidgets = null;
        state.autoPrecision = null;
        if (!customDimensions) return;
        if (!hasCustomSize(state.model, state.params.tier_id) || !Object.hasOwn(state.params.user_params, "size")) return;
        const pair = parseCustomSize(state.params.user_params.size);
        if (pair) setCustomSize(pair.width, pair.height);
    }

    function addWidget(type, name, value, callback, options = {}) {
        const widget = transient(node.addWidget(type, name, value, (...args) => {
            const result = callback(...args);
            scheduleWorkflowSave(node);
            return result;
        }, options));
        panelControl(widget);
        state.dynamic.push(widget);
        return widget;
    }

    function selectWidget(name, options, current, callback) {
        const entries = options.map((option) => {
            const value = optionValue(option);
            const label = String(option?.label ?? (typeof value === "object" ? JSON.stringify(value) : value));
            return { label, value };
        });
        // Distinguish duplicate labels without changing the submitted value's type.
        const counts = new Map();
        for (const entry of entries) counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1);
        for (const entry of entries) if (counts.get(entry.label) > 1) entry.label += ` (${JSON.stringify(entry.value)})`;
        let chosen = entries.find((entry) => same(entry.value, current));
        if (!chosen) {
            chosen = { label: `已失效 · ${String(current ?? "未设置")}`, value: current };
            entries.unshift(chosen);
        }
        return addWidget("combo", name, chosen.label, (label) => {
            const entry = entries.find((e) => e.label === label);
            if (entry) callback(clone(entry.value));
        }, { values: entries.map((entry) => entry.label) });
    }

    function drawParams() {
        clearDynamic();
        const model = state.model;
        if (!model) { resize(node); return; }
        const tiers = model.tiers ?? [];
        if (tiers.length) {
            selectWidget("线路选择", tiers.map((t) => ({ value: tierId(t), label: t.name ?? tierId(t) })), state.params.tier_id, (id) => {
                state.params = initParams(model, { ...state.params, tier_id: id }, true);
                restoreCustomSize();
                drawParams(); sync(); show("已切换线路；不兼容的参数已恢复为可用值，请核对。");
            });
        }
        const tier = getTier(model, state.params.tier_id);
        const supportsCustom = customDimensions && hasCustomSize(model, state.params.tier_id);
        const custom = supportsCustom && Object.hasOwn(state.params.user_params, "size");
        for (const field of fieldsFor(model, state.params.tier_id)) {
            if (field.visible === false || field.fixed || field.disabled) continue;
            if (customDimensions && field.key === "size") {
                if (!custom) continue;
                const pair = parseCustomSize(state.params.user_params.size) ?? { width: 0, height: 0 };
                const options = { min: 1, max: Number.MAX_SAFE_INTEGER, step: (tier.custom_size_rules.dimension_step || 1) * 10, precision: 0 };
                const width = addWidget("number", "宽度", pair.width, (value) => {
                    setCustomSize(value, state.sizeWidgets.height.value); sync(); show(state.message);
                }, options);
                const height = addWidget("number", "高度", pair.height, (value) => {
                    setCustomSize(state.sizeWidgets.width.value, value); sync(); show(state.message);
                }, { ...options });
                width.tooltip = height.tooltip = field.description ?? "宽高会按当前线路规则自动校准。";
                state.sizeWidgets = { width, height };
                continue;
            }
            const label = field.label ?? field.key;
            const value = state.params.user_params[field.key] ?? defaultValue(field);
            if (customDimensions && field.key === "aspect_ratio" && (supportsCustom || Object.hasOwn(state.params.user_params, "size"))) {
                const options = [...(field.options ?? [])];
                if (supportsCustom) options.push({ value: CUSTOM_SIZE_OPTION, label: "自定义" });
                selectWidget(label, options, custom ? CUSTOM_SIZE_OPTION : value, (next) => {
                    state.sizeNotice = "";
                    if (next === CUSTOM_SIZE_OPTION) {
                        const pair = state.lastSize ?? seedCustomSize(model, state.params);
                        setCustomSize(pair.width, pair.height);
                    } else {
                        delete state.params.user_params.size;
                        state.params.user_params.aspect_ratio = next;
                    }
                    drawParams(); sync(); show(state.message);
                });
                continue;
            }
            if (field.key === "image_size" && custom) {
                const text = String(field.options?.find((o) => same(optionValue(o), value))?.label ?? value);
                const widget = addWidget("text", `${label}（自动）：${text}`, text, () => {});
                widget.disabled = true;
                widget.tooltip = "根据自定义宽高的总像素自动计算，与平台计价精度一致。";
                state.autoPrecision = { widget, field };
                continue;
            }
            const changed = (next) => {
                if (next === "") delete state.params.user_params[field.key];
                else state.params.user_params[field.key] = next;
                sync(); show(state.message);
            };
            let widget;
            if (multi(field)) {
                for (const option of field.options ?? []) {
                    const item = optionValue(option);
                    widget = addWidget("toggle", `${label} · ${option.label ?? item}`, (Array.isArray(value) ? value : []).some((v) => same(v, item)), (on) => {
                        const selected = state.params.user_params[field.key] ?? [];
                        changed(on ? [...selected.filter((v) => !same(v, item)), item] : selected.filter((v) => !same(v, item)));
                    });
                }
            } else if (field._hasOptions) {
                widget = selectWidget(label, field.options, value, changed);
            } else if (field.ui_type === "toggle" || field.type === "boolean") {
                widget = addWidget("toggle", label, Boolean(value), changed);
            } else if (isNumericField(field)) {
                widget = addWidget("number", label, Number(value), (next) => {
                    const normalized = normalizeNumericValue(field, next);
                    widget.value = normalized;
                    changed(normalized);
                }, { min: field.min ?? -1e9, max: field.max ?? 1e9, step: (field.step ?? 1) * 10,
                    precision: Number.isInteger(field.step ?? 1) && Number.isInteger(field.min ?? 0) ? 0 : 3 });
            } else {
                const objectValue = typeof value === "object" && value !== null;
                widget = addWidget("text", label, objectValue ? JSON.stringify(value) : String(value ?? ""), (next) => {
                    if (!objectValue) return changed(next);
                    try { changed(JSON.parse(next)); } catch { show(`${label}需要有效的 JSON。`); }
                });
            }
            if (widget) widget.tooltip = field.description ?? "";
        }
        renderPanel();
        resize(node);
    }

    function chooseModel(model, restore, manual = false) {
        const changed = String(state.modelId.value) !== String(model.id);
        state.model = model;
        state.modelId.value = String(model.id);
        state.selector.value = modelLabel(model);
        state.params = initParams(model, restore ? parseParams(state.paramsWidget.value) : null, !restore);
        state.lastSize = null;
        restoreCustomSize();
        if (manual) {
            const count = changed ? (options.disconnectIncompatibleReferences ?? disconnectIncompatibleReferences)(node, model, state.params) : 0;
            state.selectionNotice = count ? `已自动断开 ${count} 条不兼容或超出上限的参考输入连线。` : "";
        }
        drawParams(); sync(); show(state.message);
    }

    async function reload(resetSelection) {
        const epoch = ++state.epoch;
        state.quoteReady = false; state.quoteKey = null; state.quoteText = "";
        ++state.quoteEpoch;
        clearTimeout(state.quoteTimer);
        state.quoteController?.abort();
        state.controller?.abort();
        state.controller = new AbortController();
        show("正在加载模型…");
        try {
            const response = await api.fetchApi(options.modelsUrl ?? "/benbh-bridge/models", { signal: state.controller.signal, cache: "no-store" });
            const data = await response.json();
            if (epoch !== state.epoch) return;
            if (!response.ok) throw new Error(data.error ?? "读取模型失败");
            state.models = data.models ?? [];
            state.selector.options.values = state.models.map(modelLabel);
            if (!state.models.length) throw new Error(`平台没有可用的${options.modelKind ?? "图片"}模型。`);
            state.authenticated = Boolean(data.authenticated);
            state.quoteReady = true;
            const savedId = String(state.modelId.value ?? "");
            const model = state.models.find((m) => String(m.id) === savedId);
            if (model) chooseModel(model, !resetSelection);
            else if (resetSelection || !savedId) chooseModel(state.models.find((m) => m.is_default) ?? state.models[0], false);
            else {
                state.quoteReady = false;
                const savedName = modelName(node.properties?.benbh_bridge?.model_snapshot ?? { name: "原模型" });
                const unavailable = `${savedName}（不可用）`;
                state.selector.options.values.unshift(unavailable);
                state.selector.value = unavailable;
                show("保存的模型已不可用，请主动选择其他模型；尚未替换模型。");
                return;
            }
            show(data.message);
        } catch (error) {
            if (epoch !== state.epoch || error.name === "AbortError") return;
            show(`${error.message}。已保留当前参数，可稍后重新打开工作流。`);
        }
    }

    state.restore = () => {
        state.runtime.restore();
        const snapshot = node.properties?.benbh_bridge?.model_snapshot;
        const saved = parseParams(state.paramsWidget.value);
        state.params = saved ?? { tier_id: "", user_params: {} };
        if (snapshot && String(snapshot.id) === String(state.modelId.value)) chooseModel(clone(snapshot), true);
        reload(false);
    };
    state.beforeConfigure = clearDynamic;
    state.sync = sync;
    state.reload = reload;
    state.connectionsChanged = () => { syncReferences(); scheduleQuote(); show(state.message); scheduleWorkflowSave(node); };
    queueMicrotask(() => { if (!state.epoch) state.restore(); });
    resize(node);
}

app.registerExtension({
    name: "Benbh.Bridge.ImageGeneration",
    beforeConfigureGraph(graph) { migrateGraph(graph); },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== CLASS) return;
        pruneDefinition(nodeData);
        chain(nodeType.prototype, "onNodeCreated", function () { setupBridge(this); });
        const configure = nodeType.prototype.configure;
        nodeType.prototype.configure = function (...args) {
            pruneWidgets(this);
            this._benbh?.beforeConfigure();
            if (args[0]) migrateNode(args[0]);
            return configure?.apply(this, args);
        };
        chain(nodeType.prototype, "onConfigure", function () {
            pruneWidgets(this);
            ensureReferenceInput(this);
            this._benbh?.restore();
        });
        chain(nodeType.prototype, "onConnectionsChange", function () {
            queueMicrotask(() => { if (this.graph) this._benbh?.connectionsChanged(); });
        });
        chain(nodeType.prototype, "onSerialize", function () { this._benbh?.sync(); });
        chain(nodeType.prototype, "onRemoved", function () {
            this._benbh?.disposePersistence?.();
            this._benbh?.controller?.abort();
            this._benbh?.quoteController?.abort();
            if (this._benbh) {
                ++this._benbh.quoteEpoch;
                clearTimeout(this._benbh.quoteTimer);
            }
        });
    },
    setup() {
        window.addEventListener("beforeunload", flushWorkflowSave);
        window.addEventListener("pagehide", flushWorkflowSave);
        api.addEventListener("benbh-bridge-status", ({ detail }) => {
            const node = app.graph?._nodes?.find((n) => String(n.id) === String(detail.node_id) && n.type === CLASS);
            if (!node?._benbh) return;
            node._benbh.receiveStatus(detail);
        });
    },
});
