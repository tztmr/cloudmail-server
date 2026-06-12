import app from '../hono/hono.js';
import roleService from '../service/role-service.js';
import userContext from '../security/user-context.js';
import result from '../model/result.js';
import permService from '../service/perm-service.js';

app.post('/role/add', async (c) => {
	await roleService.add(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok());
});

app.put('/role/setDefault', async (c) => {
	await roleService.setDefault(c, await c.req.json());
	return c.json(result.ok());
});

app.put('/role/set', async (c) => {
	await roleService.setRole(c, await c.req.json());
	return c.json(result.ok());
});

app.get('/role/tree', async (c) => {
	const tree = await permService.tree(c);
	return c.json(result.ok(tree));
});

app.delete('/role/delete', async (c) => {
	await roleService.delete(c, c.req.query());
	return c.json(result.ok());
});

app.get('/role/list', async (c) => {
	const roleList = await roleService.roleList(c);
	return c.json(result.ok(roleList));
});

app.get('/role/selectUse', async (c) => {
	const roleList = await roleService.roleSelectUse(c);
	return c.json(result.ok(roleList));
});



