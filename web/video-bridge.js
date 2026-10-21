import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { setupBridge } from "./bridge.js";
import { videoMediaInfo, videoReferenceCounts, videoReferenceLinks, syncVideoReferenceInputs, disconnectIncompatibleVideoReferences } from "./video-media.js";

const CLASS = "BenbhVideoGenerate";
const chain = (target, name, callback) => {
    const original = target[name];
    target[name] = function (...args) {
        const result = original?.apply(this, args);
        callback.apply(this, args);
        return result;
    };
};

app.registerExtension({
    name: "Benbh.Bridge.VideoGeneration",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== CLASS) return;
        // Declare all IMAGE ports for backend validation, render only the
        // current model's supported types and one vacant slot per type.
        for (const name of Object.keys(nodeData.input?.optional ?? {})) {
            if (/^reference_images_\d+$|^reference_(videos|audios)(?:_\d+)?$/.test(name)) delete nodeData.input.optional[name];
        }
        if (nodeData.input_order?.optional) nodeData.input_order.optional = nodeData.input_order.optional.filter(name => !/^reference_images_\d+$|^reference_(videos|audios)(?:_\d+)?$/.test(name));
        chain(nodeType.prototype, "onNodeCreated", function () {
            setupBridge(this, { customDimensions: false, modelKind: "视频", taskFamily: "video",
                modelsUrl: "/benbh-bridge/video/models", quoteUrl: "/benbh-bridge/video/quote",
                mediaInfo: videoMediaInfo, referenceCounts: videoReferenceCounts, referenceLinks: videoReferenceLinks,
                syncReferenceInputs: syncVideoReferenceInputs, disconnectIncompatibleReferences: disconnectIncompatibleVideoReferences });
        });
        const configure = nodeType.prototype.configure;
        nodeType.prototype.configure = function (...args) {
            this._benbh?.beforeConfigure();
            return configure?.apply(this, args);
        };
        chain(nodeType.prototype, "onConfigure", function () { this._benbh?.restore(); });
        chain(nodeType.prototype, "onConnectionsChange", function () {
            queueMicrotask(() => { if (this.graph) this._benbh?.connectionsChanged(); });
        });
        chain(nodeType.prototype, "onSerialize", function () { this._benbh?.sync(); });
        chain(nodeType.prototype, "onRemoved", function () {
            const state = this._benbh;
            state?.disposePersistence?.();
            state?.controller?.abort();
            state?.quoteController?.abort();
            if (state) { ++state.quoteEpoch; clearTimeout(state.quoteTimer); }
        });
    },
    setup() {
        api.addEventListener("benbh-bridge-video-status", ({ detail }) => {
            const node = app.graph?._nodes?.find(n => String(n.id) === String(detail.node_id) && n.type === CLASS);
            const state = node?._benbh;
            if (!state) return;
            state.receiveStatus(detail);
        });
    },
});
