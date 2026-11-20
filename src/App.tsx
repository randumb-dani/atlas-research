import "streamdown/styles.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ModelPanel } from "@/components/model-panel";
import { ResearchChat } from "@/components/research-chat";
import { CrwSettings } from "@/components/crw-settings";
import { ProgressBar } from "@/components/progress-bar";
import type { SessionState } from "@/lib/store";
import { useSessionStore } from "@/lib/store";
import { useTheme } from "@/lib/theme-provider";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Settings, Sun, Moon, Monitor, MessageSquare, Globe, Brain } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEffect, useState } from "react";
import { testLlmConnection, type LlmTestResult } from "@/lib/api";
import { LLM_PROVIDERS, LLM_PROVIDER_IDS } from "@/lib/llm-provider";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-is-mobile";

// Pre-extracted selectors to avoid recreating functions on every render.
const selectOrchestratorModel = (s: SessionState) => s.orchestratorModel;
const selectSubagentModel = (s: SessionState) => s.subagentModel;
const selectPhase = (s: SessionState) => s.phase;

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const next = theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  return (
    <Button variant="outline" size="sm" onClick={() => setTheme(next)} className="gap-2 text-xs">
      <Icon className="size-3.5" />
      {theme === "light" ? "Light" : theme === "dark" ? "Dark" : "System"}
    </Button>
  );
}

function App() {
  const orchestratorModel = useSessionStore(selectOrchestratorModel);
  const subagentModel = useSessionStore(selectSubagentModel);
  const setOrchestratorModel = useSessionStore((s) => s.setOrchestratorModel);
  const setSubagentModel = useSessionStore((s) => s.setSubagentModel);
  const phase = useSessionStore(selectPhase);
  const isIdle = phase === "idle";
  const { resolvedTheme } = useTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const isMobile = useIsMobile();

  return (
    <TooltipProvider>
      <div className="relative flex h-dvh flex-col">
        {!isIdle && phase !== "done" && (
          <div className="shrink-0">
            <ProgressBar />
          </div>
        )}
        {isIdle && (
          <header className="flex items-center justify-between border-b border-border/60 bg-background/50 px-4 py-2 backdrop-blur-sm">
            <div className="flex items-center gap-1.5">
              <img
                src={resolvedTheme === "dark" ? "/logos/atlas-logo-blue.png" : "/logos/atlas-logo-orange.png"}
                alt="Atlas"
                className="size-5"
              />
              <h1 className="font-heading text-base font-semibold tracking-tight">Atlas</h1>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" onClick={() => setSettingsOpen(true)} aria-label="Settings">
                <Settings className="size-4" />
              </Button>
            </div>
          </header>
        )}

        <SettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          orchestratorModel={orchestratorModel}
          subagentModel={subagentModel}
          setOrchestratorModel={setOrchestratorModel}
          setSubagentModel={setSubagentModel}
        />

        <main className="relative flex flex-1 min-h-0 z-10">
          <ResearchChat sourcesOpen={sourcesOpen} onSourcesOpenChange={setSourcesOpen} onSettingsClick={() => setSettingsOpen(true)} />
        </main>

        {isMobile && (
          <nav className="flex items-center justify-around border-t border-border/60 bg-card px-2 py-1.5 z-20">
            {[
              { icon: MessageSquare, label: "Chat", onClick: () => {} },
              { icon: Globe, label: "Sources", onClick: () => setSourcesOpen(true) },
              { icon: Settings, label: "Settings", onClick: () => setSettingsOpen(true) },
            ].map(({ icon: Icon, label, onClick }) => (
              <button
                key={label}
                onClick={onClick}
                className={cn(
                  "flex flex-col items-center gap-0.5 px-4 py-1.5 rounded-lg text-xs font-medium transition-colors",
                  label === "Chat" ? "text-primary" : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="size-5" />
                {label}
              </button>
            ))}
          </nav>
        )}
      </div>
    </TooltipProvider>
  );
}

function SettingsDialog({
  open,
  onOpenChange,
  orchestratorModel,
  subagentModel,
  setOrchestratorModel,
  setSubagentModel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orchestratorModel: string | null;
  subagentModel: string | null;
  setOrchestratorModel: (m: string) => void;
  setSubagentModel: (m: string) => void;
}) {
  const llmProvider = useSessionStore((s) => s.llmProvider);
  const setLlmProvider = useSessionStore((s) => s.setLlmProvider);
  const lmStudioUrl = useSessionStore((s) => s.lmStudioUrl);
  const setLmStudioUrl = useSessionStore((s) => s.setLmStudioUrl);
  const unslothUrl = useSessionStore((s) => s.unslothUrl);
  const setUnslothUrl = useSessionStore((s) => s.setUnslothUrl);
  const unslothApiKey = useSessionStore((s) => s.unslothApiKey);
  const setUnslothApiKey = useSessionStore((s) => s.setUnslothApiKey);

  const engineInfo = LLM_PROVIDERS[llmProvider];
  const isUnsloth = llmProvider === "unsloth";
  const baseUrl = isUnsloth ? unslothUrl : lmStudioUrl;
  const setBaseUrl = isUnsloth ? setUnslothUrl : setLmStudioUrl;

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<LlmTestResult | null>(null);

  // A stale green result from the previous engine would be actively
  // misleading — clear it whenever the target changes.
  useEffect(() => { setTestResult(null); }, [llmProvider, baseUrl, unslothApiKey]);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await testLlmConnection());
    } finally {
      setTesting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="w-full max-w-[90vw] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto p-5 pt-3 space-y-5">
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Models</h3>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Orchestrator</span>
                <ModelPanel
                  inline
                  selectedModel={orchestratorModel}
                  onSelectModel={(m) => { setOrchestratorModel(m); }}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">Subagent</span>
                <ModelPanel
                  inline
                  selectedModel={subagentModel}
                  onSelectModel={(m) => { setSubagentModel(m); }}
                />
              </div>
            </div>
          </section>
          <Separator />
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">LLM Engine</h3>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2" role="group" aria-label="Inference backend">
                {LLM_PROVIDER_IDS.map((id) => {
                  const selected = llmProvider === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setLlmProvider(id)}
                      aria-pressed={selected}
                      className={cn(
                        "rounded-lg border px-3 py-2 text-left transition-colors",
                        selected
                          ? "border-primary/50 bg-primary/10 text-foreground"
                          : "border-border/60 text-muted-foreground hover:bg-muted/30",
                      )}
                    >
                      <span className="block text-xs font-semibold">{LLM_PROVIDERS[id].label}</span>
                      <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">
                        {id === "lmstudio" ? "Native API · load/unload" : "OpenAI-compatible · API key"}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="space-y-2">
                <label htmlFor="llm-base-url" className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Brain className="size-3" />
                  {engineInfo.label} URL
                </label>
                <Input
                  id="llm-base-url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={engineInfo.defaultUrl}
                />
                <p className="text-[11px] text-muted-foreground/80">{engineInfo.hint}</p>
              </div>

              {engineInfo.requiresApiKey && (
                <div className="space-y-2">
                  <label htmlFor="llm-api-key" className="block text-xs font-medium text-muted-foreground">
                    API Key
                  </label>
                  <Input
                    id="llm-api-key"
                    type="password"
                    autoComplete="off"
                    value={unslothApiKey}
                    onChange={(e) => setUnslothApiKey(e.target.value)}
                    placeholder="sk-unsloth-…"
                  />
                  <p className="text-[11px] text-muted-foreground/80">{engineInfo.keyHint}</p>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={handleTest} disabled={testing} className="text-xs">
                  {testing ? "Testing…" : "Test Connection"}
                </Button>
                {testResult && (
                  <span
                    className={cn(
                      "text-[11px] break-words",
                      testResult.success ? "text-emerald-600 dark:text-emerald-400" : "text-destructive",
                    )}
                  >
                    {testResult.success
                      ? `Connected — ${testResult.models?.length ?? 0} model(s) available${
                          testResult.models?.length
                            ? `: ${testResult.models.slice(0, 3).join(", ")}${testResult.models.length > 3 ? "…" : ""}`
                            : ""
                        }`
                      : `Failed: ${testResult.error}`}
                  </span>
                )}
              </div>
            </div>
          </section>
          <Separator />
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Appearance</h3>
            <ThemeToggle />
          </section>
          <Separator />
          <CrwSettings inline />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default App;
