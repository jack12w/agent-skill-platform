import { Injectable } from '@nestjs/common';

export interface SendMailOptions {
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

/**
 * 统一邮件发送封装（nodemailer + SMTP）。
 * SMTP 未配置或发送失败时仅记录日志，不抛异常（避免阻断主流程）。
 */
@Injectable()
export class EmailService {
  private transporter: any = null;

  /** 懒加载并复用 SMTP 传输器（带超时，避免 SMTP 不可达时挂起请求） */
  private getTransporter() {
    if (this.transporter) return this.transporter;
    const nodemailer = require('nodemailer');
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.qq.com',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: false,
      // 连接池：允许多封邮件并发复用 TCP/TLS 连接，避免逐个重开连接拖慢批量发送
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
      // 关键：设置超时，避免 SMTP 不可达时挂起整个请求（最长 15s）
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    return this.transporter;
  }

  async sendMail({ to, subject, text, html }: SendMailOptions): Promise<boolean> {
    if (!to) {
      console.log('[SMTP] 收件人为空，跳过发送');
      return false;
    }
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
      console.warn('[SMTP] SMTP_USER 或 SMTP_PASS 未配置，无法发送邮件');
      return false;
    }
    try {
      const info = await this.getTransporter().sendMail({
        from: `"SkillDepot" <${process.env.SMTP_USER}>`,
        to,
        subject,
        text,
        html,
      });
      console.log(`[SMTP] 邮件发送成功: ${to}, messageId=${info.messageId}`);
      return true;
    } catch (e: any) {
      console.error('[SMTP] 邮件发送失败:', e?.message || e);
      // 重置传输器，下次重试时重建连接
      this.transporter = null;
      return false;
    }
  }
}
