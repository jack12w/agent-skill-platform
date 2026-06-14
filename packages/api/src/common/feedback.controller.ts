import { Controller, Post, Body, Req } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Feedback } from './feedback.entity';
import { Request } from 'express';
import { JwtService } from '@nestjs/jwt';

@Controller('feedback')
export class FeedbackController {
  constructor(
    @InjectRepository(Feedback) private fbRepo: Repository<Feedback>,
    private jwtService: JwtService,
  ) {}

  @Post()
  async submit(@Body() body: { name: string; email: string; content: string }, @Req() req: Request) {
    if (!body.name?.trim() || !body.content?.trim()) return { ok: false, message: 'Name and content are required' };

    let userId: string | null = null;
    try {
      const token = req.headers.authorization?.split(' ')[1];
      if (token) {
        const payload = this.jwtService.decode(token) as { sub: string } | null;
        userId = payload?.sub || null;
      }
    } catch {}

    await this.fbRepo.save({
      name: body.name.slice(0, 100),
      email: body.email?.slice(0, 200) || '',
      content: body.content.slice(0, 5000),
      user_id: userId,
    });
    return { ok: true };
  }
}
