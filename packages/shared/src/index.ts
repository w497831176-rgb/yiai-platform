export interface HealthStatus {
  status: 'ok' | 'error';
  service: string;
  environment: string;
  database?: 'connected' | 'disconnected';
  message?: string;
}

export function isValidRole(role: string): role is 'user' | 'admin' {
  return role === 'user' || role === 'admin';
}
