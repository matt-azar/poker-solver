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

/** Published caps from GET /v1/bounds (and session.info.bounds). */
export type RiverBetaBoundsInfo = {
  max_concurrent_sessions?: number;
  max_session_idle_sec?: number;
  max_memory_mib?: number;
  default_memory_mib?: number;
  max_iterations?: number;
  default_iterations?: number;
  max_time_limit_sec?: number;
  default_time_limit_sec?: number;
  max_threads?: number;
  max_weighted_combos_per_player?: number;
  max_river_bet_sizes?: number;
  max_raises?: number;
  max_plan_memory_bytes?: number;
  summary?: string;
  street?: string;
  ok?: boolean;
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
  idle_remaining_sec?: number;
  last_used_at?: number;
  bounds?: RiverBetaBoundsInfo;
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
  lastBounds: RiverBetaBoundsInfo | null = null;
  lastIdleRemainingSec: number | null = null;

  constructor(baseUrl: string = defaultBaseUrl()) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  /** Clear local session id without calling DELETE (e.g. after server reap). */
  clearLocalSession(): void {
    this.sessionId = null;
    this.lastActiveJobId = null;
    this.lastIdleRemainingSec = null;
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

  private applySession(session: RiverBetaSessionInfo | undefined): void {
    if (!session) return;
    if (session.metrics) this.lastMetrics = session.metrics;
    if (session.bounds) this.lastBounds = session.bounds;
    if (typeof session.idle_remaining_sec === "number") {
      this.lastIdleRemainingSec = session.idle_remaining_sec;
    }
    if (typeof session.active_job_id === "string") {
      this.lastActiveJobId = session.active_job_id;
    }
  }

  async health(): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/health`, {
      credentials: "include",
      headers: this.headers(),
    });
    return this.parse(res);
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
    this.applySession(session);
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
      this.clearLocalSession();
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

  async bounds(): Promise<RiverBetaBoundsInfo> {
    const res = await fetch(`${this.baseUrl}/v1/bounds`, {
      credentials: "include",
      headers: this.headers(),
    });
    const data = await this.parse(res);
    this.lastBounds = data as RiverBetaBoundsInfo;
    return this.lastBounds;
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
    this.applySession(session);
    return session;
  }
}
