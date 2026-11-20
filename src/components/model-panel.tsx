import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { listModels, loadModel, unloadModel } from "@/lib/api";
import { LLM_PROVIDERS, normalizeLlmProvider } from "@/lib/llm-provider";
import { useSessionStore } from "@/lib/store";
import type { LMModel } from "@/lib/types";
import { Search, RefreshCw, Cpu, Loader2, Zap, Box, ChevronDown } from "lucide-react";

interface ModelPanelProps {
  selectedModel: string | null;
  onSelectModel: (model: string) => void;
  inline?: boolean;
}

export function ModelPanel({ selectedModel, onSelectModel, inline }: ModelPanelProps) {
  const [open, setOpen] = useState(false);

  if (inline) {
    return <ModelPanelInline selectedModel={selectedModel} onSelectModel={onSelectModel} />;
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" className="gap-2 text-xs" onClick={() => setOpen(true)}>
        <Cpu className="size-3.5" />
        {selectedModel || "Select Model"}
        {selectedModel && <span className="size-1.5 rounded-full bg-green-500" />}
      </Button>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Available Models</DialogTitle>
        </DialogHeader>
        <ModelPanelContent selectedModel={selectedModel} onSelectModel={(m) => { onSelectModel(m); setOpen(false); }} />
      </DialogContent>
    </Dialog>
  );
}

function ModelPanelInline({ selectedModel, onSelectModel }: ModelPanelProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-sm hover:bg-muted/30 transition-colors"
      >
        <Cpu className="size-3.5 text-muted-foreground" />
        <span className="flex-1 text-left">{selectedModel || <span className="text-muted-foreground">Select Model</span>}</span>
        {selectedModel && <span className="size-1.5 rounded-full bg-green-500" />}
        <ChevronDown className={`size-3.5 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>
      {expanded && (
        <div className="border border-border/60 rounded-lg bg-background overflow-hidden">
          <ModelPanelContent selectedModel={selectedModel} onSelectModel={(m) => { onSelectModel(m); setExpanded(false); }} />
        </div>
      )}
    </div>
  );
}

function ModelPanelContent({ selectedModel, onSelectModel }: { selectedModel: string | null; onSelectModel: (model: string) => void }) {
  const provider = useSessionStore((s) => normalizeLlmProvider(s.llmProvider));
  const providerInfo = LLM_PROVIDERS[provider];
  // LM Studio exposes load/unload + capability metadata. OpenAI-compatible
  // backends (Unsloth Studio, llama-server…) own the model lifecycle and
  // report neither, so the UI adapts instead of offering dead buttons.
  const canManageModels = providerInfo.nativeApi;

  const [models, setModels] = useState<LMModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [loadConfig, setLoadConfig] = useState({
    context_length: 16384,
    flash_attention: true,
  });
  const [loadTarget, setLoadTarget] = useState<LMModel | null>(null);
  const [filterToolUse, setFilterToolUse] = useState(true);

  const fetch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const m = await listModels();
      setModels(m);
    } catch (err) {
      // An unreachable endpoint used to render as a bare "No models found",
      // which reads like an empty library rather than a connection or 401
      // problem — surface the real error instead.
      setModels([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetch(); }, [fetch, provider]);

  const filtered = models
    .filter((m) => m.type === "llm")
    // Only LM Studio reports trained_for_tool_use; filtering OpenAI-compatible
    // lists on it would hide every model.
    .filter((m) => !filterToolUse || !canManageModels || m.capabilities?.trained_for_tool_use)
    .filter((m) =>
      !searchQuery ||
      m.display_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      m.publisher.toLowerCase().includes(searchQuery.toLowerCase()) ||
      m.key.toLowerCase().includes(searchQuery.toLowerCase())
    );

  const [loadingModel, setLoadingModel] = useState(false);

  const handleLoad = async () => {
    if (!loadTarget || loadingModel) return;
    setLoadingModel(true);
    try {
      await loadModel({
        model: loadTarget.key,
        context_length: loadConfig.context_length,
        flash_attention: loadConfig.flash_attention,
      });
      setLoadTarget(null);
      fetch();
    } finally {
      setLoadingModel(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search models..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8 text-sm"
          />
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-border/60 px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/30">
          <input
            type="checkbox"
            checked={filterToolUse}
            onChange={(e) => setFilterToolUse(e.target.checked)}
            className="size-3 accent-primary"
          />
          Tool-use
        </label>
        <Button variant="ghost" size="icon" onClick={fetch} disabled={loading}>
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <p className="font-medium">Couldn't reach {providerInfo.label}</p>
          <p className="mt-0.5 break-words opacity-80">{error}</p>
        </div>
      )}

      <ScrollArea className="h-64">
        <div className="space-y-1 pr-2">
          {filtered.map((model) => {
            const loaded = model.loaded_instances.length > 0;
            const isSelected = loadTarget?.key === model.key;
            const isCurrent = model.key === selectedModel;
            return (
              <div
                key={model.key}
                className={`flex items-center justify-between rounded-lg border px-3 py-2 transition-all hover:bg-muted/30 ${
                  isCurrent ? "border-primary/50 bg-primary/5 ring-1 ring-primary/20" : isSelected ? "border-primary/40 bg-primary/5" : "border-border/60"
                }`}
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{model.display_name}</span>
                    {model.capabilities?.vision && (
                      <Badge variant="outline" className="text-[10px]">vision</Badge>
                    )}
                    {model.loaded === false && (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground">not loaded</Badge>
                    )}
                    {isCurrent && (
                      <Badge variant="success" size="sm">Selected</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span>{model.publisher}</span>
                    <span className="text-border">|</span>
                    <span>{model.params_string || "?"}</span>
                    {model.quantization?.name && (
                      <>
                        <span className="text-border">|</span>
                        <span>{model.quantization.name}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <div className={`mr-1 size-1.5 rounded-full ${loaded && model.loaded !== false ? "bg-green-500" : "bg-muted-foreground/40"}`} />
                  {canManageModels ? (
                    loaded ? (
                      <>
                        <Button variant="secondary" size="xs" onClick={() => onSelectModel(model.key)}>
                          Use
                        </Button>
                        <Button variant="ghost" size="xs" onClick={() => unloadModel({ instance_id: model.loaded_instances[0].id }).then(fetch)}>
                          Unload
                        </Button>
                      </>
                    ) : (
                      <Button variant="outline" size="xs" onClick={() => setLoadTarget(model)}>
                        Load
                      </Button>
                    )
                  ) : (
                    <Button variant="secondary" size="xs" onClick={() => onSelectModel(model.key)}>
                      Use
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
          {filtered.length === 0 && !error && (
            <div className="flex h-24 flex-col items-center justify-center px-4 text-center text-sm text-muted-foreground">
              <Box className="mb-2 size-6" />
              <p>No models found</p>
              {!canManageModels && (
                <p className="mt-1 text-[11px] leading-snug">
                  Load a model in {providerInfo.label}, then press refresh.
                </p>
              )}
            </div>
          )}
        </div>
      </ScrollArea>

      {canManageModels && loadTarget && (
        <div className="rounded-xl border border-primary/20 bg-primary/[0.03] p-3 shadow-sm">
          <div className="mb-2 flex items-center gap-2">
            <Cpu className="size-4 text-primary" />
            <h4 className="text-sm font-heading font-semibold">Load {loadTarget.display_name}</h4>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] font-medium text-muted-foreground">Context Length</label>
              <Input
                type="number"
                value={loadConfig.context_length}
                onChange={(e) => setLoadConfig((c) => ({ ...c, context_length: Number(e.target.value) }))}
                className="mt-1 h-7 text-sm"
              />
            </div>
            <div className="flex items-end pb-1">
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/30">
                <input
                  type="checkbox"
                  checked={loadConfig.flash_attention}
                  onChange={(e) => setLoadConfig((c) => ({ ...c, flash_attention: e.target.checked }))}
                  className="size-3 accent-primary"
                />
                <Zap className="size-3" />
                Flash Attention
              </label>
            </div>
          </div>
          <div className="mt-2 flex gap-2">
            <Button onClick={handleLoad} loading={loadingModel} className="gap-1.5 text-xs">
              <Loader2 className="size-3" /> Confirm Load
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setLoadTarget(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
