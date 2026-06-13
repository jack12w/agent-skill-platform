import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  @Column({ select: false })
  password_hash: string;

  @Column()
  name: string;

  @Column({ default: 'user' })
  role: string;

  @Column({ nullable: true })
  avatar_url: string;

  @Column({ nullable: true })
  bio: string;

  @Column({ nullable: true, select: false })
  wechat_openid: string;

  @Column({ nullable: true, select: false })
  wechat_unionid: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
