type Observation = { value: number; timestamp: Date };
type Patient = { procedure?: Date; observations: Observation[] };

export type DistributionStrategy = "recompute" | "incremental";

export type MonthRow = { mean: number; stdev: number; q25: number; q75: number; count: number };

// The statistics of one month bucket. Both strategies produce the same row;
// they differ in when the work is done.
interface MonthStatistics {
  add(value: number): void;
  readonly count: number;
  row(): MonthRow;
}

function interpolate(lower: number, upper: number, position: number): number {
  return lower === upper ? lower : lower + (upper - lower) * (position - Math.floor(position));
}

// Keeps every value and computes the row when it is read: one pass for mean
// and variance and a sort for the quartiles, so a read costs O(n log n).
class RecomputedMonth implements MonthStatistics {
  private values: number[] = [];

  add(value: number) {
    this.values.push(value);
  }

  get count() {
    return this.values.length;
  }

  row(): MonthRow {
    const values = this.values;
    const sorted = [...values].sort((a, b) => a - b);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    return {
      mean,
      stdev: Math.sqrt(variance),
      q25: this.percentile(sorted, 0.25),
      q75: this.percentile(sorted, 0.75),
      count: values.length,
    };
  }

  private percentile(sorted: number[], fraction: number): number {
    const position = (sorted.length - 1) * fraction;
    return interpolate(sorted[Math.floor(position)], sorted[Math.ceil(position)], position);
  }
}

// Maintains the row as values arrive: a running sum for the mean (summed in
// arrival order, so it equals the recomputed mean bit for bit and rounds the
// same way), Welford's running variance, and a count per distinct value for
// exact quartiles. A read costs
// O(distinct values), which is bounded by the measurement resolution
// (0.01 kg) rather than by the number of observations.
class IncrementalMonth implements MonthStatistics {
  private n = 0;
  private sum = 0;
  private runningMean = 0;
  private m2 = 0;
  private histogram = new Map<number, number>();
  private sortedKeys: number[] | undefined = [];

  add(value: number) {
    this.n += 1;
    this.sum += value;
    const delta = value - this.runningMean;
    this.runningMean += delta / this.n;
    this.m2 += delta * (value - this.runningMean);
    const count = this.histogram.get(value);
    if (count === undefined) this.sortedKeys = undefined;
    this.histogram.set(value, (count ?? 0) + 1);
  }

  get count() {
    return this.n;
  }

  row(): MonthRow {
    const p25 = (this.n - 1) * 0.25;
    const p75 = (this.n - 1) * 0.75;
    const [q25Low, q25High, q75Low, q75High] = this.ranks(
      [Math.floor(p25), Math.ceil(p25), Math.floor(p75), Math.ceil(p75)],
    );
    return {
      mean: this.sum / this.n,
      stdev: Math.sqrt(this.m2 / this.n),
      q25: interpolate(q25Low, q25High, p25),
      q75: interpolate(q75Low, q75High, p75),
      count: this.n,
    };
  }

  // The values at the given ascending 0-based ranks, in one pass over the
  // sorted distinct values. The key order is cached until a new value appears.
  private ranks(ranks: number[]): number[] {
    this.sortedKeys ??= [...this.histogram.keys()].sort((a, b) => a - b);
    const results: number[] = [];
    let seen = 0;
    for (const key of this.sortedKeys) {
      seen += this.histogram.get(key)!;
      while (results.length < ranks.length && ranks[results.length] < seen) results.push(key);
      if (results.length === ranks.length) break;
    }
    return results;
  }
}

export class WeightDistribution {
  private patients = new Map<string, Patient>();
  private pendingObservations = new Map<string, Observation[]>();
  private monthly = new Map<number, MonthStatistics>();

  constructor(readonly strategy: DistributionStrategy = "recompute") {}

  addPatient(patientId: string) {
    if (this.patients.has(patientId)) return;
    const patient: Patient = { observations: [] };
    this.patients.set(patientId, patient);
    this.flush(patientId);
  }

  addProcedure(patientId: string, timestamp: Date) {
    if (!this.patients.has(patientId)) this.addPatient(patientId);
    const patient = this.patients.get(patientId)!;
    if (!patient.procedure) patient.procedure = timestamp;
    this.flush(patientId);
  }

  addObservation(patientId: string, value: number, timestamp: Date) {
    const patient = this.patients.get(patientId);
    if (!patient?.procedure) {
      const pending = this.pendingObservations.get(patientId) ?? [];
      pending.push({ value, timestamp });
      this.pendingObservations.set(patientId, pending);
      return;
    }
    this.record(patient, value, timestamp);
  }

  toCSV(): string {
    const lines = ["month,avg_weight,stdev,q25,q75,count"];
    for (const month of [...this.monthly.keys()].sort((a, b) => a - b)) {
      const row = this.monthly.get(month)!.row();
      lines.push([
        month,
        row.mean.toFixed(2),
        row.stdev.toFixed(2),
        row.q25.toFixed(2),
        row.q75.toFixed(2),
        row.count,
      ].join(","));
    }
    return lines.join("\n");
  }

  stats() {
    return {
      patients: this.patients.size,
      pendingPatients: this.pendingObservations.size,
      observations: [...this.monthly.values()].reduce((total, month) => total + month.count, 0),
      months: this.monthly.size,
    };
  }

  private flush(patientId: string) {
    const patient = this.patients.get(patientId);
    if (!patient?.procedure) return;
    const pending = this.pendingObservations.get(patientId) ?? [];
    for (const observation of pending) this.record(patient, observation.value, observation.timestamp);
    this.pendingObservations.delete(patientId);
  }

  private record(patient: Patient, value: number, timestamp: Date) {
    patient.observations.push({ value, timestamp });
    const procedure = patient.procedure!;
    const month = (timestamp.getUTCFullYear() - procedure.getUTCFullYear()) * 12
      + timestamp.getUTCMonth() - procedure.getUTCMonth();
    let statistics = this.monthly.get(month);
    if (!statistics) {
      statistics = this.strategy === "incremental" ? new IncrementalMonth() : new RecomputedMonth();
      this.monthly.set(month, statistics);
    }
    statistics.add(value);
  }
}
