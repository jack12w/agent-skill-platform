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
  async sendMail({ to, subject, text, html }: SendMailOptions): Promise<boolean> {
    if (!to) return false;
    try {
      // 延迟 require，避免在无 nodemailer 环境下启动报错
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.qq.com',
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });
      await transporter.sendMail({
        from: `"SkillDepot" <${process.env.SMTP_USER || 'noreply@example.com'}>`,
        to,
        subject,
        text,
        html,
      });
      return true;
    } catch (e: any) {
      console.error('[SMTP] 邮件发送失败:', e?.message || e);
      return false;
    }
  }
}
