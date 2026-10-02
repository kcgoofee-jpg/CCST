// 环境变量的值：去掉首尾空白，再去掉最外层成对的引号。
// 用 `docker run --env-file`、compose 列表写法（- KEY="abc"）时，引号会原样进来，
// 密码会因此对不上、后端名认不出来，而且没有任何报错。中间的引号不动。
export function envValue(raw) {
    const s = String(raw ?? '').trim();
    return s.length >= 2 && /^(["']).*\1$/.test(s) ? s.slice(1, -1).trim() : s;
}
