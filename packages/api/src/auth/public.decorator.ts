import { SetMetadata } from '@nestjs/common';

/**
 * 标记某个路由为「公开」：即使控制器类级别挂了 AuthGuard，被 @Public() 标注的方法
 * 也允许匿名访问（AuthGuard 读取该 metadata 后直接放行）。
 * 用于纯公开数据接口（如创作者订阅数统计），避免被类级 AuthGuard 连坐要求登录。
 */
export const IS_PUBLIC_KEY = 'isPublic';

export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
