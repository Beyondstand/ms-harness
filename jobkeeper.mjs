// ms-harness — 作业看护：轮询 ms_job_list，状态迁移时通知 UI 并唤醒模型收尾
export class JobKeeper {
  constructor({ poll, onEvent, intervalMs = 60000 }) {
    this.poll = poll; // () => Promise<{isError, structured}> | null
    this.onEvent = onEvent;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.last = null; // Map(jobId -> job)
    this.seeded = false;
    this.polling = false;
  }

  start() {
    this.stop();
    this.seeded = false;
    this.timer = setInterval(() => this.pollOnce(), this.intervalMs);
    // 启动即先轮询一次建立基线
    setTimeout(() => this.pollOnce(), 1500);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async pollOnce() {
    if (this.polling) return;
    this.polling = true;
    try {
      const res = await this.poll();
      if (!res || res.isError) return;
      const jobs = res.structured?.jobs || [];
      const now = new Map(jobs.map((j) => [j.id, j]));
      if (!this.seeded) {
        this.last = now;
        this.seeded = true;
        return;
      }
      for (const [id, j] of now) {
        const prev = this.last.get(id);
        const done = j.state === "completed" || j.state === "failed";
        const transitioned = prev && prev.state === "running" && done;
        const appearedDone = !prev && done; // 看护启动后才提交、已直接结束的作业
        if (transitioned || appearedDone) {
          this.onEvent({
            type: "job_event",
            jobId: id,
            state: j.state,
            script: j.script,
            taskDir: j.taskDir,
            exitCode: j.exitCode,
          });
        }
      }
      this.last = now;
    } catch {
      // 桥未就绪 / 轮询失败：静默等下一轮
    } finally {
      this.polling = false;
    }
  }
}
