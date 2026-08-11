import dotenv from 'dotenv';

dotenv.config();

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  PORT: parseInt(process.env.YIAI_PLATFORM_API_PORT ?? '3000', 10),
  HOST: process.env.YIAI_PLATFORM_API_HOST ?? '0.0.0.0',
  DB_HOST: process.env.YIAI_PLATFORM_DB_HOST ?? 'localhost',
  DB_PORT: parseInt(process.env.YIAI_PLATFORM_DB_PORT ?? '5432', 10),
  DB_USER: process.env.YIAI_PLATFORM_DB_USER ?? 'yiai',
  DB_PASSWORD: process.env.YIAI_PLATFORM_DB_PASSWORD ?? '',
  DB_NAME: process.env.YIAI_PLATFORM_DB_NAME ?? 'yiai_platform',
  DATABASE_URL: process.env.YIAI_PLATFORM_DATABASE_URL,
  JWT_SECRET: process.env.YIAI_PLATFORM_JWT_SECRET ?? '',
  FEEDBACK_UPLOAD_DIR: process.env.YIAI_PLATFORM_FEEDBACK_UPLOAD_DIR ?? '/app/data/feedback-uploads',
};
