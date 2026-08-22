/**
 * 独立 Parser 的轻量健康与元数据端点。
 * readiness 不访问数据库或模型，只证明进程配置已校验且全部格式 Parser 已注册。
 *
 * @requirement PAR-004
 * @requirement PAR-015
 */
import { Controller, Get, Inject, SetMetadata } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@rag/config';
import { PUBLIC_ROUTE_METADATA } from '@rag/contracts';
import type { ParserRegistry } from '@rag/document-parser-core';
import { DOCUMENT_PARSER_REGISTRY } from './tokens';

/** Kubernetes 和内网部署平台可调用的 Parser 健康控制器。 */
@Controller('health')
@SetMetadata(PUBLIC_ROUTE_METADATA, true)
export class ParserHealthController {
  public constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DOCUMENT_PARSER_REGISTRY) private readonly registry: ParserRegistry,
  ) {}

  /** 存活只表示事件循环可服务。 */
  @Get('live')
  public live(): { status: 'up'; service: string } {
    return { status: 'up', service: 'document-parser-service' };
  }

  /** 就绪同时公开非敏感的协议、修订和格式能力，供 Profile 握手。 */
  @Get('ready')
  public ready(): {
    status: 'up';
    revision: string;
    protocolVersion: string;
    formats: readonly string[];
  } {
    return {
      status: 'up',
      revision: this.config.fileProcessing.parser.revision,
      protocolVersion: this.config.fileProcessing.parser.protocolVersion,
      formats: this.registry.formats(),
    };
  }
}
