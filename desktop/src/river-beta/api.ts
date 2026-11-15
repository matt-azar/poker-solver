/**
 * HTTP client for services/river-beta (typed IPC behind isolated sessions).
 */

export type RiverBetaMetrics = {
  cpu_user_sec?: number;
  cpu_system_sec?: number;
  cpu_total_sec?: number;
  peak_rss_bytes?: number;
  last_rss_bytes?: number;
  solve_wall_sec?: number;
  solve_count?: number;
  samples?: number;
  last_error?: string | null;
};

export type RiverBetaEnvelope = {
  v?: number;
  kind?: string;
  request_id?: string;
  job_id?: string | null;
  op?: string;
  ok?: boolean;
  error_code?: string | null;
  error_message?: string | null;
  body?: unknown;
};

export type RiverBetaSessionInfo = {
  session_id: string;
  metrics?: RiverBetaMetrics;
  active_job_id?: string | null;
  alive?: boolean;
};

function defaultBaseUrl(): string {
  const fromEnv = import.meta.env.VITE_RIVER_BETA_URL;
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return fromEnv.trim().replace(/\/$/, "");
  }
  return "http://127.0.0.1:8787";
}

export class RiverBetaApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RiverBetaApiError";
    this.code = code;
  }
}

export class RiverBetaApi {
  readonly baseUrl: string;
  private sessionId: string | null = null;
  lastMetrics: RiverBetaMetrics | null = null;
  lastActiveJobId: string | null = null;

  constructor(baseUrl: string = defaultBaseUrl()) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  private headers(json = false): HeadersInit {
    const h: Record<string, string> = {};
    if (json) h["Content-Type"] = "application/json";
    if (this.sessionId) h["X-River-Beta-Session"] = this.sessionId;
    return h;
  }

  private async parse(res: Response): Promise<Record<string, unknown>> {
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new RiverBetaApiError("bad_json", `non-JSON response (${res.status})`);
    }
    if (!res.ok || data.ok === false) {
      const code =
        typeof data.error_code === "string" ? data.error_code : `http_${res.status}`;
      const message =
        typeof data.error_message === "string"
          ? data.error_message
          : `river-beta request failed (${res.status})`;
      throw new RiverBetaApiError(code, message);
    }
    if (data.metrics && typeof data.metrics === "object") {
      this.lastMetrics = data.metrics as RiverBetaMetrics;
    }
    if (typeof data.active_job_id === "string") {
      this.lastActiveJobId = data.active_job_id;
    }
    return data;
  }

  async createSession(): Promise<RiverBetaSessionInfo> {
    const res = await fetch(`${this.baseUrl}/v1/sessions`, {
      method: "POST",
      credentials: "include",
      headers: this.headers(true),
      body: "{}",
    });
    const headerSid = res.headers.get("X-River-Beta-Session");
    const data = await this.parse(res);
    const session = data.session as RiverBetaSessionInfo | undefined;
    this.sessionId = headerSid || session?.session_id || null;
    if (!this.sessionId) {
      throw new RiverBetaApiError("no_session", "service did not return a session id");
    }
    if (session?.metrics) this.lastMetrics = session.metrics;
    return session ?? { session_id: this.sessionId };
  }

  async destroySession(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await fetch(`${this.baseUrl}/v1/sessions/me`, {
        method: "DELETE",
        credentials: "include",
        headers: this.headers(),
      });
    } finally {
      this.sessionId = null;
      this.lastActiveJobId = null;
    }
  }

  async defaultConfig(): Promise<string> {
    const res = await fetch(`${this.baseUrl}/v1/default-config`, {
      credentials: "include",
      headers: this.headers(),
    });
    const data = await this.parse(res);
    const text = data.config_text;
    if (typeof text !== "string" || !text.trim()) {
      throw new RiverBetaApiError("invalid_config", "default config missing");
    }
    return text;
  }

  async bounds(): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/v1/bounds`, {
      credentials: "include",
      headers: this.headers(),
    });
    return this.parse(res);
  }

  async ipc(
    op: string,
    body: unknown = null,
    jobId?: string | null,
  ): Promise<RiverBetaEnvelope> {
    if (!this.sessionId) {
      throw new RiverBetaApiError("no_session", "create a session first");
    }
    const res = await fetch(`${this.baseUrl}/v1/sessions/me/ipc`, {
      method: "POST",
      credentials: "include",
      headers: this.headers(true),
      body: JSON.stringify({
        op,
        body,
        job_id: jobId ?? null,
      }),
    });
    const data = await this.parse(res);
    const envelope = data.envelope as RiverBetaEnvelope | undefined;
    if (!envelope || typeof envelope !== "object") {
      throw new RiverBetaApiError("bad_envelope", "IPC proxy returned no envelope");
    }
    return envelope;
  }

  async solve(opts?: {
    config_text?: string;
    iterations?: number;
    time_limit?: number;
  }): Promise<Record<string, unknown>> {
    if (!this.sessionId) {
      throw new RiverBetaApiError("no_session", "create a session first");
    }
    const res = await fetch(`${this.baseUrl}/v1/sessions/me/solve`, {
      method: "POST",
      credentials: "include",
      headers: this.headers(true),
      body: JSON.stringify(opts ?? {}),
    });
    return this.parse(res);
  }

  async cancel(jobId?: string | null): Promise<Record<string, unknown>> {
    if (!this.sessionId) {
      throw new RiverBetaApiError("no_session", "create a session first");
    }
    const res = await fetch(`${this.baseUrl}/v1/sessions/me/cancel`, {
      method: "POST",
      credentials: "include",
      headers: this.headers(true),
      body: JSON.stringify({ job_id: jobId ?? this.lastActiveJobId }),
    });
    return this.parse(res);
  }

  async resolve(opts?: {
    iterations?: number;
    time_limit?: number;
  }): Promise<Record<string, unknown>> {
    if (!this.sessionId) {
      throw new RiverBetaApiError("no_session", "create a session first");
    }
    const res = await fetch(`${this.baseUrl}/v1/sessions/me/resolve`, {
      method: "POST",
      credentials: "include",
      headers: this.headers(true),
      body: JSON.stringify(opts ?? {}),
    });
    return this.parse(res);
  }

  async sessionInfo(): Promise<RiverBetaSessionInfo> {
    if (!this.sessionId) {
      throw new RiverBetaApiError("no_session", "create a session first");
    }
    const res = await fetch(`${this.baseUrl}/v1/sessions/me`, {
      credentials: "include",
      headers: this.headers(),
    });
    const data = await this.parse(res);
    const session = data.session as RiverBetaSessionInfo;
    if (session?.metrics) this.lastMetrics = session.metrics;
    return session;
  }
}
