// src/keyboards.ts
// Telegram inline keyboard definitions — one place for all button layouts.

import { Markup } from 'telegraf';

export const KB = {
  /** Shown on /start */
  start: Markup.inlineKeyboard([
    [Markup.button.callback('🔗 Connect Your Binance Wallet', 'connect_wallet')],
    [Markup.button.callback('📱 Generate QR Code', 'generate_qr')],
    [Markup.button.callback('📋 My Completed Jobs & Agent IDs', 'my_jobs')],
    [Markup.button.callback('❌ Cancel', 'cancel')],
  ]),

  /** Shown after wallet connection link is generated */
  afterConnect: Markup.inlineKeyboard([
    [Markup.button.callback('📱 Generate QR Code', 'generate_qr')],
    [Markup.button.callback('🚀 Complete All Process', 'complete_process')],
    [Markup.button.callback('❌ Cancel', 'cancel')],
  ]),

  /** Shown after QR code is sent */
  afterQr: Markup.inlineKeyboard([
    [Markup.button.callback('🚀 Complete All Process', 'complete_process')],
    [Markup.button.callback('❌ Cancel', 'cancel')],
  ]),

  /** Shown when execution is running (single cancel button) */
  cancelOnly: Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel Job', 'cancel')],
  ]),

  /** Shown after completion / error */
  postExecution: Markup.inlineKeyboard([
    [Markup.button.callback('🚀 Complete All Process', 'complete_process')],
    [Markup.button.callback('📋 My Completed Jobs & Agent IDs', 'my_jobs')],
    [Markup.button.callback('❌ Cancel', 'cancel')],
  ]),
};
