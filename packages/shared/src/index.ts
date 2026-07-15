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

export interface User {
  id: string;
  username: string;
  role: 'user' | 'admin';
  created_at: string;
  updated_at: string;
}

export interface SafeUser {
  id: string;
  username: string;
  role: 'user' | 'admin';
}

export interface AuthResponse {
  token: string;
  user: SafeUser;
}

export interface RegisterRequest {
  username: string;
  password: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}
