/** Prometheus 抓取入口。生产环境应由网络策略限制为监控系统可访问。 */
import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MetricsService } from './metrics.service';

@Controller('metrics')
export class MetricsController {
  public constructor(@Inject(MetricsService) private readonly metrics: MetricsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  public async scrape(@Res({ passthrough: true }) response: Response): Promise<string> {
    response.setHeader('Content-Type', this.metrics.contentType);
    return this.metrics.render();
  }
}
