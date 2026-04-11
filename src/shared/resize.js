/**
 * リサイズ目標寸法計算
 *
 * AWS sharp の挙動 (httpdocs/OriginRequest/index.js) に合わせる:
 * - _w のみ      : width=reqW, height は比例 (sharp fit:contain 単一指定)
 * - _h のみ      : height=reqH, width は比例
 * - _w + _h 両方 : 両辺が requested 以下になる最大スケールで縮小 (sharp fit:inside)
 *
 * いずれも該当しない場合は null を返す。
 */
export function computeTargetSize(srcW, srcH, reqW, reqH) {
  if (reqW && !reqH) {
    return {
      width: reqW,
      height: Math.max(1, Math.round(srcH * (reqW / srcW))),
    };
  }
  if (!reqW && reqH) {
    return {
      width: Math.max(1, Math.round(srcW * (reqH / srcH))),
      height: reqH,
    };
  }
  if (reqW && reqH) {
    const scale = Math.min(reqW / srcW, reqH / srcH);
    return {
      width: Math.max(1, Math.round(srcW * scale)),
      height: Math.max(1, Math.round(srcH * scale)),
    };
  }
  return null;
}
