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
  login_reward?: {
    streak_days: number;
    reward_tokens: number;
    granted_tokens: number;
  };
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

export type YiaiAppType = 'chatflow' | 'agent';

export interface YiaiApp {
  id: string;
  slug: string;
  app_type: YiaiAppType;
  name: string;
  description: string | null;
  icon: string | null;
  icon_type: 'image' | 'emoji' | null;
  icon_url: string | null;
  icon_background: string | null;
  tags?: string[];
  sort_order: number;
  supports_images: boolean;
  requires_new_conversation_inputs: boolean;
  created_at: string;
  updated_at: string;
}

export type UserInputFormType = 'text-input' | 'paragraph' | 'select';

export interface UserInputFormOption {
  label: string;
  value: string;
}

export interface UserInputFormField {
  type: UserInputFormType;
  label: string;
  variable: string;
  required: boolean;
  default?: string;
  options?: UserInputFormOption[];
}

export interface AppBootstrap {
  app: YiaiApp;
  opening_statement: string | null;
  suggested_questions: string[] | null;
  user_input_form: UserInputFormField[] | null;
}

export interface YiaiConversation {
  id: string;
  name: string;
  inputs: Record<string, unknown>;
  status: string;
  updated_at: number;
  created_at: number;
}

export interface YiaiMessageFile {
  type: string;
  url: string;
}

export interface YiaiMessage {
  id: string;
  conversation_id: string;
  query: string;
  answer: string;
  message_files?: YiaiMessageFile[] | null;
  created_at: number;
  metadata?: {
    usage?: {
      total_tokens?: number;
    };
  };
}

export interface ChatRequestFile {
  type: 'image';
  transfer_method: 'local_file';
  upload_file_id: string;
}

export interface ChatRequest {
  query: string;
  conversation_id?: string;
  inputs?: Record<string, unknown>;
  files?: ChatRequestFile[];
}

export interface UploadedFile {
  id: string;
  type: string;
  url?: string;
}

export interface ChatStreamEvent {
  event: string;
  data?: Record<string, unknown>;
}
