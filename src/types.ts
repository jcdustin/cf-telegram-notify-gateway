export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  GATEWAY_SECRET: string;
  TELEGRAM_MESSAGE_THREAD_ID?: string;
}

export type ParseMode = "HTML" | "MarkdownV2";

export interface NotifyMessage {
  text: string;
  parse_mode?: ParseMode;
  disable_notification?: boolean;
  protect_content?: boolean;
}

export interface TelegramSendMessage extends NotifyMessage {
  chat_id: string;
  message_thread_id?: number;
}

export interface TelegramSuccess {
  ok: true;
  result: { message_id: number };
}

export interface TelegramFailure {
  ok: false;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export type TelegramResponse = TelegramSuccess | TelegramFailure;
