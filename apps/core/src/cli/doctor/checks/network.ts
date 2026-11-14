import { type effectiveNetwork, isLoopback } from '../../../modules/admin/index.ts'
import type { Check, DoctorCheck } from '../types.ts'

export function networkCheck(net: ReturnType<typeof effectiveNetwork>): Check {
  const loop = isLoopback(net.host)
  const secure = net.publicUrl?.startsWith('https://') === true
  const local = net.publicUrl !== undefined && /\/\/(localhost|127\.|\[::1\])/.test(net.publicUrl)
  if (net.mode === 'local' && !loop) {
    return {
      level: 'warn',
      name: 'access',
      hint: `mode local but bound to ${net.host}: keith-core access local`,
    }
  }
  if (net.mode === 'remote') {
    if (net.publicUrl === undefined) {
      return {
        level: 'warn',
        name: 'access',
        hint: 'remote without a public URL: nodes will be told localhost; keith-core access remote --public-url <url>',
      }
    }
    if (loop && !secure && !local) {
      return {
        level: 'warn',
        name: 'access',
        hint: `bound to ${net.host} but ${net.publicUrl} is not https: nothing proxies to loopback; bind wider or use tailscale serve`,
      }
    }
  }
  return {
    level: 'ok',
    name: 'access',
    hint: `${net.mode}, bind ${net.host}:${net.port}${net.publicUrl === undefined ? '' : `, public ${net.publicUrl}`}`,
  }
}

export const networkTableCheck: DoctorCheck = ({ net }) => [networkCheck(net)]
