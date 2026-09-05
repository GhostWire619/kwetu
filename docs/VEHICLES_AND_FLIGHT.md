# Vehicles and flight contract

Status: accepted documentation baseline, 2026-09-05. No implementation or performance claim. This document owns vehicle capabilities, movement regimes, landing and vehicle persistence. Coordinates and time remain owned by [COORDINATE_SYSTEM.md](../COORDINATE_SYSTEM.md); network authority by [NETWORKING.md](../NETWORKING.md); measurements and delivery gates by [ROADMAP.md](../ROADMAP.md). The rationale and research are recorded in [ADR-001](adr/ADR-001-flight-frames-and-clock.md).

## 1. A fleet, not one rocket

Vehicle identity is separate from propulsion and movement regime. A rocket is a propulsion/vehicle family, not a synonym for every spacecraft. A shuttle may be both atmospheric and orbital; a lunar lander cannot be assumed capable of lifting off from Earth. Adding a model must not create another movement engine.

| Family | Required capabilities | Constraints and initial delivery |
|---|---|---|
| Cars, daladala, bajaji, rovers | wheels, steering, brakes, seats, suspension | Ground contact; rover body/environment compatibility; car first in Phase 4 |
| Boats, dhows, powered watercraft | buoyancy, water propulsion or sail model | Water required; no orbital controls; later surface expansion |
| Aircraft | lift, control surfaces, atmospheric engine | Density and runway/VTOL requirements; later expansion |
| Expendable launch rockets | stages, tanks, engines, payload attachment | Staging and finite propellant; Phase 7 reference launch vehicle |
| Reusable launchers | launch capabilities plus recovery system | Landing gear, reserve propellant and recovery envelope; Phase 7 extension |
| Capsules | crew seats, attitude control, heat shield, recovery | May need carrier rocket; parachutes only in supported atmospheres |
| Orbital shuttles / spaceplanes | orbital propulsion, entry protection, atmospheric controls | Powered and gliding regimes; runway and vertical landing are separate capabilities |
| Lunar / planetary landers | throttleable descent propulsion, gear, crew/cargo | Body-specific thrust and thermal envelope; Phase 8 second distinct craft |
| Exploration ships / freighters / passenger ships | navigation, propulsion, power, cargo or passenger capacity | Large ships may be orbit-only and need landers; later fleet expansion |
| Tugs / probes / satellites | attitude control, docking or remote control, power | Uncrewed is a control capability; does not bypass ownership checks |
| Fictional fast-travel ships | explicit transit drive component | Separate fictional transport mode; never presented as ordinary rocket physics |

A configuration lists allowed environments and actions. UI enables controls by capability and state, never by checking a display name. The same type can have multiple sizes, engines, interiors, liveries and loadouts. A registry validation error rejects impossible combinations before loading a session.

## 2. Definitions, instances and components

Proposed schema contracts below are documentation, not existing interfaces. All records have a schema version. Quantities are SI and explicitly named; display units may differ.

`VehicleDefinition`: stable definition ID and revision; localized name/description keys; family tags; asset/provenance IDs; dry mass and inertia model; colliders; seats; attachment graph; supported environment envelope; component definitions; control mapping; landing modes; damage model. An asset has independent render LODs, simplified collision geometry and attachment transforms.

`VehicleInstance`: entity ID; definition ID/revision; owner ID; authority revision; frame-tagged positionMetres, velocityMetresPerSecond, orientation quaternion, angularVelocityRadiansPerSecond; worldTime; movement regime; fuel by tank; stored energy; temperatures/damage; current stage; attached entity IDs; seat occupants; cargo references; autopilot state; landing/docking transaction; last durable event ID.

Components include engines, tanks, batteries/generators, reaction wheels/RCS, wings/control surfaces, wheels, buoyancy, landing gear, parachutes, heat shields, cargo bays, docking ports, seats, airlocks and optional transit drives. Unsupported components fail visibly; no silent inert placeholders.

Engine records specify propellant compatibility, thrust curve versus throttle and ambient pressure, specific impulse, restart limits and ignition conditions. Mass changes as tanks drain; cargo and detached stages affect mass, centre of mass and inertia. Reference model: mass flow = thrust / (specificImpulseSeconds × standardGravityMetresPerSecondSquared). Standard gravity here is a unit conversion constant, not the current planet's gravity. Never consume negative fuel. NASA describes thrust and specific impulse in its [rocket thrust reference](https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/rocket-thrust-equation/). This is a simplified game model, not an engine certification model.

Staging is an atomic server-approved graph split: transfer components and remaining propellant to distinct entity IDs, conserve initial position and velocity, apply a defined separation impulse, and persist once. Repeated commands with the same request ID cannot create duplicate stages or payloads. Debris follows a bounded lifecycle policy; distant debris is not permanently simulated with contact physics.

## 3. Exactly one movement owner

| Regime | Movement owner | Forces and transitions |
|---|---|---|
| CONTACT_LOCAL | Client local Rapier bubble, reconciled with server-approved kinematics | Walking, wheels, touchdown and nearby interactions; bounded local f32 solver |
| FLIGHT_DYNAMIC | f64 flight integrator in the simulation core | Powered ascent, burns, atmospheric entry, descent; gravity, thrust, drag, attitude and resource integration |
| ORBIT_COAST | f64 conic propagator | Unpowered two-body approximation; exit before burn, meaningful drag, contact, or sphere-of-influence crossing |
| ATTACHED | Parent transform and joint/seat contract | Seated occupants, landed secured craft, docked craft and payloads; no second independent integration |
| TRANSIT_FICTIONAL | Server-approved route evaluator | Optional later fictional propulsion; explicit entry/exit and exclusion volumes |

Regime selection depends on forces and proximity, not on whether speed exceeds an arbitrary number or whether the clock is accelerated. A slow hovering lander still needs powered flight. A fast unpowered craft may coast. Planets follow the ephemeris adapter independently; never propagate a planet using a player's patched-conic orbit.

FLIGHT_DYNAMIC uses a versioned fixed-step force model with bounded substeps and swept terrain/body queries. Near a possible contact, preload colliders and transfer ownership to CONTACT_LOCAL before penetration. The contact model receives equivalent thrust/gravity while active. Never integrate the same vehicle in both solvers and blend their answers. Far-flight proxies are query/render-only until ownership transfers. Errors trigger a visible hold/abort/recovery policy rather than tunnelling through terrain.

Every transfer occurs on an agreed tick: capture old state; convert position, velocity, orientation and angular velocity in f64; create the destination representation; verify collision readiness; commit the new regime and revision; remove old ownership. Preserve fuel, seats, parent graph and ongoing command acknowledgements. Hysteresis prevents rapid switching; distances and tolerances are measured by S0.7 and Phase 7, not asserted here.

Sphere-of-influence transfer changes reference body using both bodies' position AND velocity at the same time. Recompute conic elements from the transformed state; do not preserve old elements under a new central mass. Rotating-frame conversions additionally include transport velocity. The transition must not create free delta-v.

## 4. Launch, entry and assisted landing

Launch sequence: board → obtain pilot authority → configure stage → validate pad clearance and capability → ignite → release restraints → powered ascent → coast or continue burn. A failed ignition does not consume the launch transaction twice. Guidance is assistance with feedback and abort, not a cutscene that ignores physics.

Atmospheric flight evaluates density, air-relative velocity, drag, lift where supported, and simplified thermal load. Distinguish ground-relative, air-relative and inertial velocity in instruments. No lift or parachute support in vacuum. Gas/ice giants offer atmospheric flight only within declared limits; they do not have a normal solid landing surface. Stars cannot be landed on.

The player can press **“Tua kwa usaidizi”** near suitable ground. This starts a visible, cancellable control sequence:

1. Validate vehicle landing capability, terrain residency and collider revision, slope, footprint clearance, descent/sideways speed, thrust authority, fuel reserve, gear condition, occupancy and server permission. Eligibility distances/speeds are per vehicle envelope, measured at Phase 7/8.
2. Reserve the destination footprint with an expiring server lease. No reservation implies physical safety by itself; keep checking obstacles.
3. Align, cancel sideways drift, deploy gear, descend, flare, establish stable contact and shut down. Animation follows controls and contacts; it does not teleport the craft to a marker.
4. Complete only when supported contact and stability checks pass; persist position, fuel, regime and reservation release atomically.
5. Abort on obstruction, lost terrain, insufficient authority/fuel, command cancellation or lease loss. Climb/hold only if the vehicle has that capability and reserve; otherwise return manual control with a specific warning. Never promise every abort is survivable.

Runway landing is a distinct guidance path requiring approach corridor, runway dimensions and braking distance. It must not reuse vertical descent logic. Auto landing is initially restricted to validated pads; arbitrary suitable terrain is a later gate using streamed collision data. A landing button on unsupported craft explains why it is unavailable.

## 5. Boarding, docking and walking

Approach → request seat → server reserves seat/control lease → attach avatar → route inputs to permitted controls. Passengers cannot obtain pilot control by changing client state. Exit uses a swept clearance query and surface velocity; deny exit into solid geometry or unsupported hazardous environments and state the reason.

Docking requires compatible ports, aligned approach, safe relative velocity and a server-owned attachment transaction. On undock, inherit parent translational velocity plus angular velocity × port offset before applying separation impulse. Test duplicate requests, simultaneous docking and authority loss. Shared vehicle interior spaces use parent-relative frames, defined in COORDINATE_SYSTEM.md; they are not a giant planet world.

Walkable interiors are a later fleet feature. During a seat-only release, represent occupants as attached seats and clearly declare that limitation. Future interiors need bounded local contact space, parent acceleration effects or an explicitly simplified artificial-gravity model, airlock transition, shared passengers and handoff tests. Persist a parent ID and local pose for occupants rather than freezing their old planetary position.

## 6. Authority, saving and disconnected travel

The server owns accepted trajectories, ownership, resources, seats, attachments, landing reservations and consequential events. Client contact effects are predictions. The chosen backend policy avoids a full server Rapier solver; it does not imply Go is technically incapable of simulation. Powered flight requires a bounded numerical validator with the same versioned forces; a closed-form conic alone cannot validate an active engine or drag.

Store durable semantic state, not Rapier handles or GPU matrices. Persist an orbit's reference body, state/epoch and force-model revision; on reconnect evaluate the sanctioned coast to current shared time. Landed state is body-fixed; attached state is parent-relative. Save migrations validate all IDs and numbers and reject unknown regimes/nonfinite values. Restore terrain before releasing controls.

Unpowered coast may continue while offline. Powered flight on disconnect follows a server-owned bounded policy (cancel manual thrust, evaluate autopilot only where scheduled server updates support it). Never numerically integrate an unlimited outage in one frame. Persist critical events atomically, acknowledge durable completion and document snapshot-loss bounds in the Alpha benchmark. Block recovery of a deleted parent with a clear safe-spawn fallback and an audit event; do not silently duplicate inventory.

## 7. Travel experience and localization

The shared universe runs at real time by default. Autopilot removes manual work, not physical travel time; real transfers can outlast a play session. Players can leave a coast running and return later. Isolated test/training sessions may accelerate time but never merge their state or discoveries into the shared universe. A later fictional drive can provide shorter journeys without shrinking distances or changing everyone's clock. It must display that distinction and use an actual server-time route to a moving destination with safe arrival checks. “Supernova” is an explosion, not a speed unit.

Candidate copy, pending native-speaker review under [the localization contract](swahili-i18n.md): “Roketi”, “Chombo cha angani”, “Chombo cha kutua”, “Ingia”, “Toka”, “Washa injini”, “Tua kwa usaidizi”, “Ghairi kutua”, “Mafuta hayatoshi”, “Eneo la kutua haliko wazi”, “Safari inaendelea”. Use separate locale keys for a physical time control and fictional rapid travel; never label both as one ambiguous “warp”.

## 8. Required acceptance evidence

S0.6/S0.7 must prove mode ownership and server/client replay with recorded inputs. Phase 7 must demonstrate an expendable staged rocket and reusable recovery configuration sharing the same framework. Phase 8 adds a distinct lander with different fuel/thrust/landing limits. Later fleet gates add a runway shuttle, orbit-only freighter, passengers and docking; not all families are promised in the first slice.

Tests must cover fuel exhaustion mid-burn, mass after staging, repeated stage commands, coast↔burn continuity, body/atmosphere crossings, rebase during descent, terrain unavailable, obstacle entering a reserved pad, landing cancellation, unsupported landing target, passenger reconnect, duplicate seat claim, dock/undock momentum, orbital offline resume, invalid save migration and server restart during an attachment transaction. Test the same action in English and Swahili and across low/high render rates. Performance and numerical tolerances belong in ROADMAP budgets and remain unmeasured until fixtures and browser runs exist.
