import { Controller, Post, Body, Req, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Feedback } from './feedback.entity';
import { Request } from 'express';
import { AuthGuard } from '../auth/auth.guard';

@Controller('feedback')
export class FeedbackController {
  constructor(
    @InjectRepository(Feedback) private fbRepo: Repository<Feedback>,
  ) {}

  @UseGuards(AuthGuard)
  @Post()
  async submit(@Body() body: { name: string; email: string; content: string }, @Req() req: any) {
    if (!body.name?.trim() || !body.content?.trim()) return { ok: false, message: 'Name and content are required' };

    await this.fbRepo.save({
      name: body.name.slice(0, 100),
      email: body.email?.slice(0, 200) || '',
      content: body.content.slice(0, 5000),
      user_id: req.user.sub,
    });
    return { ok: true };
  }
}
