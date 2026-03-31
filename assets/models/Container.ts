import type { ContainerHealth, ContainerJson, ContainerStat, ContainerState, LogStat } from "@/types/Container";
import { Ref } from "vue";

export type Stat = Omit<ContainerStat, "id">;
export type LogFreq = Omit<LogStat, "id">;

const hosts = computed(() =>
  config.hosts.reduce(
    (acc, item) => {
      acc[item.id] = item;
      return acc;
    },
    {} as Record<string, { name: string; id: string }>,
  ),
);

export class GroupedContainers {
  constructor(
    public readonly name: string,
    public readonly containers: Container[],
  ) {}
}

export class HistoricalContainer {
  constructor(
    public readonly container: Container,
    public readonly date: Date,
  ) {}
}

const defaultLogFreq: LogFreq = { info: 0, warn: 0, error: 0, debug: 0, fatal: 0 };
const LOG_STATS_HISTORY_SIZE = 60;
const RESTART_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

export class Container {
  private _stat: Ref<Stat>;
  private _name: string;
  private readonly _statsHistory: Ref<Stat[]>;
  private readonly movingAverageStat: Ref<Stat>;
  private readonly _logStatsHistory: Ref<LogFreq[]>;
  readonly _logStatsVersion: Ref<number>;

  // Crash-loop / exit tracking
  public lastExitCode: string | null = null;
  private _restartTimestamps: number[] = [];
  private _cachedRestartCount: number = 0;
  private _restartCacheTime: number = 0;

  constructor(
    public readonly id: string,
    public readonly created: Date,
    public startedAt: Date,
    public finishedAt: Date,
    public readonly image: string,
    name: string,
    public readonly command: string,
    public readonly host: string,
    public readonly labels = {} as Record<string, string>,
    public state: ContainerState,
    public readonly cpuLimit: number,
    public readonly memoryLimit: number,
    stats: Stat[],
    public readonly group?: string,
    public health?: ContainerHealth,
    public isNew: boolean = false,
  ) {
    const defaultStat = { cpu: 0, memory: 0, memoryUsage: 0, networkRxTotal: 0, networkTxTotal: 0 } as Stat;
    this._stat = ref(stats.at(-1) || defaultStat);
    const recentStats = stats.slice(-300);
    const padding = Array(300 - recentStats.length).fill(defaultStat);
    this._statsHistory = ref([...padding, ...recentStats]);
    this.movingAverageStat = ref(stats.at(-1) || defaultStat);
    const logPadding = Array(LOG_STATS_HISTORY_SIZE).fill(defaultLogFreq);
    this._logStatsHistory = ref(logPadding);
    this._logStatsVersion = ref(0);

    this._name = name;
  }

  get logStatsHistory() {
    return unref(this._logStatsHistory);
  }

  get logStatsVersion(): number {
    return isRef(this._logStatsVersion) ? this._logStatsVersion.value : (this._logStatsVersion as unknown as number);
  }

  get statsHistory() {
    return unref(this._statsHistory);
  }

  get movingAverage() {
    return unref(this.movingAverageStat);
  }

  get stat() {
    return unref(this._stat);
  }

  get hostLabel() {
    return hosts.value[this.host]?.name;
  }

  get storageKey() {
    return `${stripVersion(this.image)}:${this.command}`;
  }

  get namespace() {
    return (
      this.labels["dev.dozzle.group"] ||
      this.labels["coolify.projectName"] ||
      this.labels["com.docker.stack.namespace"] ||
      this.labels["com.docker.compose.project"]
    );
  }

  get customGroup() {
    return this.group;
  }

  set name(name: string) {
    this._name = name;
  }

  get name() {
    return this.isSwarm
      ? this.labels["com.docker.swarm.task.name"]
          .replace(`.${this.labels["com.docker.swarm.task.id"]}`, "")
          .replace(`.${this.labels["com.docker.swarm.node.id"]}`, "")
      : this._name;
  }

  get swarmId() {
    return this.labels["com.docker.swarm.task.name"].replace(this.name + ".", "");
  }

  get isSwarm() {
    return Boolean(this.labels["com.docker.swarm.service.id"]);
  }

  public updateStat(stat: Stat) {
    // When Container is inside a reactive array, refs get unwrapped
    if (isRef(this._stat)) {
      this._stat.value = stat;
    } else {
      (this._stat as unknown as Stat) = stat;
    }

    // Update history directly (no watcher needed)
    const history = isRef(this._statsHistory) ? this._statsHistory.value : (this._statsHistory as unknown as Stat[]);
    history.push(stat);
    if (history.length > 300) {
      history.shift();
    }

    // Calculate EMA directly (no watcher needed)
    const alpha = 0.2;
    const prev = isRef(this.movingAverageStat)
      ? this.movingAverageStat.value
      : (this.movingAverageStat as unknown as Stat);
    const newEma = {
      cpu: alpha * stat.cpu + (1 - alpha) * prev.cpu,
      memory: alpha * stat.memory + (1 - alpha) * prev.memory,
      memoryUsage: alpha * stat.memoryUsage + (1 - alpha) * prev.memoryUsage,
      networkRxTotal: stat.networkRxTotal,
      networkTxTotal: stat.networkTxTotal,
    };
    if (isRef(this.movingAverageStat)) {
      this.movingAverageStat.value = newEma;
    } else {
      (this.movingAverageStat as unknown as Stat) = newEma;
    }
  }

  public updateLogStat(logStat: LogFreq) {
    const history = isRef(this._logStatsHistory)
      ? this._logStatsHistory.value
      : (this._logStatsHistory as unknown as LogFreq[]);
    history.push(logStat);
    if (history.length > LOG_STATS_HISTORY_SIZE) {
      history.shift();
    }
    if (isRef(this._logStatsVersion)) {
      this._logStatsVersion.value++;
    } else {
      (this._logStatsVersion as unknown as number)++;
    }
  }

  public recordDie(exitCode?: string) {
    this.lastExitCode = exitCode ?? null;
  }

  public recordRestart() {
    const now = Date.now();
    this._restartTimestamps.push(now);
    // Keep only timestamps within the window
    const cutoff = now - RESTART_WINDOW_MS;
    this._restartTimestamps = this._restartTimestamps.filter((t) => t > cutoff);
  }

  get restartCount(): number {
    const now = Date.now();
    // Re-compute at most once per second to avoid repeated Date.now()+filter calls
    if (now - this._restartCacheTime < 1000) {
      return this._cachedRestartCount;
    }
    const cutoff = now - RESTART_WINDOW_MS;
    // Prune stale timestamps while counting
    this._restartTimestamps = this._restartTimestamps.filter((t) => t > cutoff);
    this._cachedRestartCount = this._restartTimestamps.length;
    this._restartCacheTime = now;
    return this._cachedRestartCount;
  }

  get isCrashLooping(): boolean {
    return this.restartCount >= 3;
  }

  get statusBadge(): { text: string; type: "error" | "warning" | "info" } | null {
    const restarts = this.restartCount;
    if (restarts >= 3) {
      return { text: `${restarts} restarts`, type: "error" };
    }
    if (this.lastExitCode && this.lastExitCode !== "0" && this.state === "exited") {
      const code = this.lastExitCode;
      // 137=SIGKILL (may be OOM but not always), 143=SIGTERM
      const label = code === "137" ? "Killed" : code === "143" ? "SIGTERM" : `Exit ${code}`;
      return { text: label, type: "warning" };
    }
    if (this.health === "unhealthy") {
      return { text: "unhealthy", type: "warning" };
    }
    return null;
  }

  /** Anomaly score for "hot" sorting — higher means more attention needed */
  get anomalyScore(): number {
    let score = 0;
    const restarts = this.restartCount;
    score += restarts * 20;
    if (this.health === "unhealthy") score += 30;
    if (this.lastExitCode && this.lastExitCode !== "0" && this.state === "exited") score += 15;
    const recent = this.logStatsHistory.slice(-3);
    for (const r of recent) {
      score += r.error * 3 + r.fatal * 10 + r.warn;
    }
    if (this.movingAverage.cpu > 80) score += 10;
    if (this.movingAverage.memory > 85) score += 10;
    return score;
  }

  static fromJSON(c: ContainerJson): Container {
    return new Container(
      c.id,
      new Date(c.created),
      new Date(c.startedAt),
      new Date(c.finishedAt),
      c.image,
      c.name,
      c.command,
      c.host,
      c.labels,
      c.state,
      c.cpuLimit,
      c.memoryLimit,
      c.stats ?? [],
      c.group,
      c.health,
    );
  }
}
