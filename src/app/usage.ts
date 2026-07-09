/**
 * Account info for /usage. Codex authenticates with an OpenAI API key or a
 * ChatGPT login stored in `$CODEX_HOME/auth.json`; we read the identity from
 * there (and confirm the live state with `codex login status`).
 */
import { codexRun } from "./codex-cli.js";
import {
  authLabel,
  authMethod,
  authUsable,
  codexAuthPath,
  identityFromAuth,
  keyFingerprint,
  keyLabel,
  readAuthFile,
} from "./codex-credentials.js";

export interface AccountInfo {
  accountType?: string;
  email?: string;
  region?: string;
  startUrl?: string;
  /** Stable identity for an API-key login (no email); used to match/dedup. */
  key?: string;
}

export class UsageService {
  constructor(private readonly codexCliPath: string) {}

  async account(): Promise<AccountInfo | undefined> {
    const auth = await readAuthFile(codexAuthPath());
    if (authUsable(auth)) {
      const id = identityFromAuth(auth);
      if (authMethod(auth) === "chatgpt") {
        return { email: id.email, accountType: id.plan || "ChatGPT" };
      }
      // API key: no email — carry a masked label + a stable match fingerprint.
      return { accountType: keyLabel(auth) || "API key", key: keyFingerprint(auth) };
    }
    // No auth.json but an API key env var still logs Codex in.
    if (process.env.OPENAI_API_KEY?.trim()) return { accountType: "API key (env)" };
    return undefined;
  }

  /**
   * Whether Codex currently has a usable login. Prefers the live
   * `codex login status`, falling back to inspecting auth.json / the env key.
   */
  async isLoggedIn(): Promise<boolean> {
    const status = await this.loginStatus();
    if (status !== undefined) return status;
    if (process.env.OPENAI_API_KEY?.trim()) return true;
    return authUsable(await readAuthFile(codexAuthPath()));
  }

  /** A short label for the active login (email / plan / method). */
  async label(): Promise<string | undefined> {
    return authLabel(await readAuthFile(codexAuthPath()));
  }

  /** Parse `codex login status`; undefined when the command isn't available. */
  private async loginStatus(): Promise<boolean | undefined> {
    try {
      const { stdout, stderr } = await codexRun(this.codexCliPath, ["login", "status"], { timeout: 10_000 });
      const out = `${stdout}${stderr}`.toLowerCase();
      if (/not logged in|no (?:active )?login|logged out/.test(out)) return false;
      if (/logged in|authenticated|using (?:an )?api key|chatgpt/.test(out)) return true;
      return undefined;
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      const out = `${err.stdout ?? ""}${err.stderr ?? ""}`.toLowerCase();
      if (/not logged in|logged out/.test(out)) return false;
      return undefined;
    }
  }
}
