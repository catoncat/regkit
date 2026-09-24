// 薄接线:把 protocol 的网关事实接进 regkit 的通用网关。
// 新上游只需改 protocol.mjs 的 gateway 对象,本文件通常不用动。

import { createGateway as regkitGateway } from 'regkit/gateway';
import { gateway as protoGateway } from './protocol.mjs';

export function createGateway({ cfg, log, usagePath, env = process.env }) {
  const token = cfg.gatewayKey ?? env[protoGateway.gatewayTokenEnv] ?? '';
  return regkitGateway({
    cfg,
    log,
    accountsFile: cfg.accountsFile,
    usagePath,
    upstreamBase: protoGateway.upstreamBase,
    rates: protoGateway.rates,
    classifyFailure: protoGateway.classifyFailure,
    gatewayToken: token,
    poolName: protoGateway.poolName,
  });
}
