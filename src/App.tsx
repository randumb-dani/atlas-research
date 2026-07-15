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
import { useState } from "react";
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
  const lmStudioUrl = useSessionStore((s) => s.lmStudioUrl);
  const setLmStudioUrl = useSessionStore((s) => s.setLmStudioUrl);

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
            <div className="space-y-2">
              <label htmlFor="lm-studio-url" className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Brain className="size-3" />
                LM Studio URL
              </label>
              <Input
                id="lm-studio-url"
                value={lmStudioUrl}
                onChange={(e) => setLmStudioUrl(e.target.value)}
                placeholder="http://localhost:1234"
              />
              <p className="text-[11px] text-muted-foreground/80">
                On a phone or another device, use the host machine's LAN address (e.g. http://192.168.1.50:1234).
              </p>
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
