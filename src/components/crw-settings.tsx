import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSessionStore } from "@/lib/store";
import { testCrwConnection } from "@/lib/api";
import { Wifi, WifiOff, Loader2, Settings2 } from "lucide-react";

export function CrwSettings({ inline }: { inline?: boolean }) {
  const crwUrl = useSessionStore((s) => s.crwUrl);
  const crwApiKey = useSessionStore((s) => s.crwApiKey);
  const setCrwUrl = useSessionStore((s) => s.setCrwUrl);
  const setCrwApiKey = useSessionStore((s) => s.setCrwApiKey);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(crwUrl);
  const [apiKey, setApiKey] = useState(crwApiKey);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const r = await testCrwConnection(url, apiKey);
    if (r.success) {
      setTestResult({ ok: true, msg: `Connected — ${r.tools?.length ?? 0} tools available` });
    } else {
      setTestResult({ ok: false, msg: r.error ?? "Connection failed" });
    }
    setTesting(false);
  };

  const handleSave = () => {
    setCrwUrl(url);
    setCrwApiKey(apiKey);
    setOpen(false);
  };

  const handleUrlChange = (v: string) => {
    setUrl(v);
    if (inline) setCrwUrl(v);
  };

  const handleKeyChange = (v: string) => {
    setApiKey(v);
    if (inline) setCrwApiKey(v);
  };

  const form = (
    <div className="space-y-4">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">CRW Connection</h3>
      <div className="space-y-2">
        <label htmlFor="crw-url" className="text-xs font-medium text-muted-foreground">MCP Server URL</label>
        <Input
          id="crw-url"
          value={url}
          onChange={(e) => handleUrlChange(e.target.value)}
          placeholder="http://localhost:3100"
        />
        <p className="text-[11px] text-muted-foreground/80">
          On a phone or another device, use the host machine's LAN address (e.g. http://192.168.1.50:3100).
        </p>
      </div>
      <div className="space-y-2">
        <label htmlFor="crw-key" className="text-xs font-medium text-muted-foreground">API Key (optional, for hosted)</label>
        <Input
          id="crw-key"
          value={apiKey}
          onChange={(e) => handleKeyChange(e.target.value)}
          placeholder="crw_live_..."
          type="password"
        />
      </div>
      {testResult && (
        <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${
          testResult.ok
            ? "border-success/30 bg-success-muted text-success"
            : "border-destructive/30 bg-destructive-muted text-destructive"
        }`}>
          {testResult.ok ? <Wifi className="mt-0.5 size-3 shrink-0" /> : <WifiOff className="mt-0.5 size-3 shrink-0" />}
          <span>{testResult.msg}</span>
        </div>
      )}
      <div className="flex gap-2">
        <Button variant="secondary" onClick={handleTest} disabled={testing || !url.trim()}>
          {testing && <Loader2 className="mr-1 size-3 animate-spin" />}
          Test Connection
        </Button>
        {!inline && <Button onClick={handleSave} className="ml-auto">Save</Button>}
      </div>
    </div>
  );

  if (inline) return form;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="ghost" size="icon" onClick={() => setOpen(true)} aria-label="CRW settings">
        <Settings2 className="size-3.5" />
      </Button>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>CRW Connection</DialogTitle>
        </DialogHeader>
        {form}
      </DialogContent>
    </Dialog>
  );
}
