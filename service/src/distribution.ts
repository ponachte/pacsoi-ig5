type Observation = { value: number; timestamp: Date };
type Patient = { procedure?: Date; observations: Observation[] };

export class WeightDistribution {
  private patients = new Map<string, Patient>();
  private pendingObservations = new Map<string, Observation[]>();
  private monthly = new Map<number, number[]>();

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
      const values = this.monthly.get(month)!;
      const sorted = [...values].sort((a, b) => a - b);
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
      lines.push([
        month,
        mean.toFixed(2),
        Math.sqrt(variance).toFixed(2),
        this.percentile(sorted, 0.25).toFixed(2),
        this.percentile(sorted, 0.75).toFixed(2),
        values.length,
      ].join(","));
    }
    return lines.join("\n");
  }

  stats() {
    return {
      patients: this.patients.size,
      pendingPatients: this.pendingObservations.size,
      observations: [...this.monthly.values()].reduce((total, values) => total + values.length, 0),
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
    const values = this.monthly.get(month) ?? [];
    values.push(value);
    this.monthly.set(month, values);
  }

  private percentile(sorted: number[], fraction: number): number {
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  }
}
