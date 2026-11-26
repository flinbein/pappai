export function assertRunnerName(name: string): void;
export function runnerDirectory(path: string, create?: boolean): void;
export function withRunnerLock<T>(root: string, name: string, operation: () => T | Promise<T>): Promise<T>;
