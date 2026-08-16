/** 身份与角色 Adapter 公共出口。 */
export const AUTH_BOUNDARY = 'auth' as const;
export * from './auth.tokens';
export * from './authentication.error';
export * from './authentication.guard';
export * from './jwt-auth.adapter';
export * from './mock-auth.adapter';
export * from './role-mapper';
export * from './trusted-header-auth.adapter';
