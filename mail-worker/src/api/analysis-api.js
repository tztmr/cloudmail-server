import app from '../hono/hono.js';
import analysisService from '../service/analysis-service.js';
import result from '../model/result.js';

app.get('/analysis/echarts', async (c) => {
	const data = await analysisService.echarts(c, c.req.query());
	return c.json(result.ok(data));
})
