export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const appEnv = (): string => process.env.APP_ENV ?? "local";

export const appVersion = (): string => process.env.APP_VERSION ?? "dev";
