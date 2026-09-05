// THROWAWAY smoke check (deleted after use): does the deterministic-compat build init in Node?
import RAPIER from '@dimforge/rapier3d-deterministic-compat';
await RAPIER.init();
const world = new RAPIER.World(new RAPIER.Vector3(0, 0, -9.80665));
world.timestep = 1 / 60;
const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, -0.5));
world.createCollider(RAPIER.ColliderDesc.cuboid(100, 100, 0.5).setFriction(0.7), ground);
const box = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0, 0.501));
const col = world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setDensity(1000).setFriction(0.7).setRestitution(0), box);
console.log('rapier version', RAPIER.version(), 'box mass', col.mass());
for (let i = 0; i < 600; i++) world.step();
const p = box.translation(), v = box.linvel();
console.log('box z after 600 steps:', p.z, 'xy', p.x, p.y, 'v', v.x, v.y, v.z);
