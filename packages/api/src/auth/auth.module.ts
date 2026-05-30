import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { User } from './user.entity';
import { VerificationCode } from './verification-code.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, VerificationCode]),
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET || (() => { throw new Error('JWT_SECRET env var is required'); })(),
      signOptions: { expiresIn: '7d' },
    }),
  ],
  providers: [AuthService],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}
