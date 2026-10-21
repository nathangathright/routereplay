"""Cheap display/graphic pass, deliberately separate from physical scene identity.

Do not move physical lighting, weather, camera motion or aircraft occlusion here.
Changing this module recomposites final frames while reusing linear HDR scenes.
"""
from functools import lru_cache
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from runtime import TRIP, WORK
from motion import Motion
from labels import Labels, visible
from fonts import flap_font
from astronomy import sun_direction
from camera_geometry import distance as camera_distance, pixel_rays, sphere_interval, project as camera_project
from radiometry import display_image, causal_exposure_profile

W,H,FPS=1080,1920,TRIP.fps
FRAME_COUNT=TRIP.frame_count
CX,CY,R=540,960,460
MOTION=Motion(TRIP)
V=MOTION.vectors
LEGS=TRIP.leg_intervals
AIRPORTS=[(a.code,a.name,a.lat,a.lon) for a in TRIP.airport_sequence]
camera=MOTION.camera
flight_progress=TRIP.progress
travel_time=TRIP.travel_time
zoom=MOTION.zoom
LABELS=Labels(MOTION)
ACCENT=(255,169,116)
FLAP_SCALE=3
CARD_W,CARD_H,CARD_GAP,PANEL_PAD=66,108,5,6
PANEL_W=3*CARD_W+2*CARD_GAP+2*PANEL_PAD
PANEL_H=CARD_H+2*PANEL_PAD
FLAP_FONT=flap_font(100*FLAP_SCALE)
FLAP_DURATION=.52
FLAP_STAGGER=.11


def project(points, bs, raised=1):
    return camera_project(points,bs,R,raised=raised)

@lru_cache(maxsize=8)
def flap_face(letter):
    scale=FLAP_SCALE
    cw,ch=CARD_W*scale,CARD_H*scale
    face=Image.new('RGBA',(cw,ch))
    d=ImageDraw.Draw(face)
    d.rounded_rectangle((0,0,cw-1,ch-1),radius=4*scale,fill=(16,17,18,255),outline=(67,69,70,255),width=scale)
    # The slightly lighter upper leaf and dark lower leaf match painted metal.
    for yy in range(2*scale,ch-2*scale):
        if yy<ch//2:
            shade=round(43-15*yy/(ch/2))
        else:
            shade=round(26-5*(yy-ch/2)/(ch/2))
        d.line((2*scale,yy,cw-2*scale-1,yy),fill=(shade,shade+1,shade+2,255))
    if letter:
        bx0,by0,bx1,by1=FLAP_FONT.getbbox(letter)
        d.text(((cw-bx0-bx1)/2,(ch-by0-by1)/2),letter,font=FLAP_FONT,fill=(248,247,241,255))
    return face


def flap_card(letter,elapsed):
    cw,ch=CARD_W*FLAP_SCALE,CARD_H*FLAP_SCALE
    half=ch//2
    blank=flap_face('')
    target=flap_face(letter)
    if elapsed<=0:
        card=blank.copy()
    elif elapsed>=FLAP_DURATION:
        card=target.copy()
    else:
        u=elapsed/FLAP_DURATION
        angle=math.pi*(.55*u+.45*u*u)
        cosine=math.cos(angle)
        card=blank.copy()
        card.paste(target.crop((0,0,cw,half)),(0,0))
        # A rigid upper leaf falls around the center axle. Its reverse carries
        # the incoming character's lower half; no unrelated text is introduced.
        height=max(1,round(half*abs(cosine)))
        leaf=(blank.crop((0,0,cw,half)) if cosine>=0
              else target.crop((0,half,cw,ch)))
        leaf=leaf.resize((cw,height),Image.Resampling.BICUBIC)
        shade=round(105*math.sin(angle))
        leaf=Image.alpha_composite(leaf,Image.new('RGBA',leaf.size,(0,0,0,shade)))
        y=half-height if cosine>=0 else half
        # Cast shadow under the moving card strengthens the hinge rotation.
        sd=ImageDraw.Draw(card)
        shadow_y=half+round(height*.35) if cosine>=0 else half+height
        sd.rectangle((2*FLAP_SCALE,shadow_y,cw-2*FLAP_SCALE,min(ch,shadow_y+5*FLAP_SCALE)),fill=(0,0,0,240))
        card.alpha_composite(leaf,(0,y))
        sd=ImageDraw.Draw(card)
        sd.line((2*FLAP_SCALE,y+(height-1 if cosine<0 else 0),cw-2*FLAP_SCALE,y+(height-1 if cosine<0 else 0)),fill=(79,80,79,230),width=FLAP_SCALE)
    d=ImageDraw.Draw(card)
    d.rectangle((0,half-FLAP_SCALE//2,cw,half+FLAP_SCALE//2),fill=(3,4,5,255))
    for x in [FLAP_SCALE,cw-3*FLAP_SCALE]:
        d.rounded_rectangle((x,half-6*FLAP_SCALE,x+2*FLAP_SCALE,half+6*FLAP_SCALE),radius=FLAP_SCALE,fill=(94,97,97,255))
        d.line((x,half-4*FLAP_SCALE,x,half+3*FLAP_SCALE),fill=(161,162,159,255),width=1)
    return card


def split_flap_panel(code,elapsed):
    scale=FLAP_SCALE
    panel=Image.new('RGBA',(PANEL_W*scale,PANEL_H*scale))
    d=ImageDraw.Draw(panel)
    d.rounded_rectangle((0,0,panel.width-1,panel.height-1),radius=7*scale,fill=(6,8,10,250),outline=(66,73,76,255),width=scale)
    for j,letter in enumerate(code):
        card=flap_card(letter,elapsed-j*FLAP_STAGGER)
        panel.alpha_composite(card,((PANEL_PAD+j*(CARD_W+CARD_GAP))*scale,PANEL_PAD*scale))
    return panel.resize((PANEL_W,PANEL_H),Image.Resampling.LANCZOS)


def arcpoints(leg, a=0, b=1, n=200):
    pp=np.linspace(a,b,n)
    points=np.asarray([MOTION.route_position(leg,float(p)) for p in pp])
    return points,1+.055*np.sin(np.pi*pp)


def line_visible(draw, pts, color, width):
    run=[]
    for x,y,z in pts:
        if z>=0:
            run.append((float(x),float(y)))
        else:
            if len(run)>1: draw.line(run,fill=color,width=width,joint='curve')
            run=[]
    if len(run)>1: draw.line(run,fill=color,width=width,joint='curve')


def route(draw, bs, leg, progress, glow=False):
    pts,raised=arcpoints(leg,0,progress,max(2,int(progress*240)))
    xyz=project(pts,bs,raised)
    line_visible(draw,xyz,(*ACCENT,150 if glow else 255),16 if glow else 5)


@lru_cache(maxsize=1)
def scene_exposure():
    """One immutable chronological exposure prepass shared by every scene layer.

    A coarse geographic diffuse proxy meters the entire viewport. This is an
    artistic camera response with bounded adaptation, not calibrated photometry.
    It deliberately excludes labels and the exaggerated aircraft footprint.
    """
    times=np.arange(FRAME_COUNT,dtype=float)/FPS
    brightness=[]
    for t in times:
        bs=np.asarray(camera(float(t)))
        origin,rays=pixel_rays(zoom(float(t)),size=(90,160),center=(45,80),
                               sensor_width=90)
        # Radius is expressed in the full canvas, so retain its angular size.
        origin[2]=camera_distance(zoom(float(t)))
        near,_,hit=sphere_interval(origin,rays)
        points=origin+near[hit,None]*rays[hit]
        solar=np.maximum(0,(points@bs)@sun_direction(travel_time(float(t))))
        brightness.append(float(np.sum(.004+.24*solar)/hit.size)+.002)
    return causal_exposure_profile(times,brightness,adaptation_seconds=TRIP.style.get('adaptation_s',.75))


def exposure_at(t):
    return float(np.interp(float(t)*FPS,np.arange(FRAME_COUNT),scene_exposure()))*2**TRIP.style.get('exposure_ev',0)


def composite(t,radiance,alpha):
    """Apply exposure and graphics to an immutable HDR scene."""
    global R
    R=zoom(t)
    top,left=CY-112,CX-112
    # The only scene display transform. All following operations are labels
    # and graphic overlays, deliberately independent of photographic exposure.
    im=display_image(radiance,exposure_at(t))
    aircraft_scene=im.crop((left,top,left+224,top+224))
    R=zoom(t)
    bs=camera(t)
    # Draw only the travelled portion of each leg, ending at the aircraft.
    glow=Image.new('RGBA',(W,H)); gd=ImageDraw.Draw(glow)
    for leg in range(len(LEGS)):
        p=flight_progress(leg,t)
        if p>0: route(gd,bs,leg,p,True)
    im=Image.alpha_composite(im,glow.filter(ImageFilter.GaussianBlur(11)))
    draw=ImageDraw.Draw(im)
    for leg in range(len(LEGS)):
        p=flight_progress(leg,t)
        if p>0: route(draw,bs,leg,p)

    # Geographic dots track the globe; labels occupy fixed, safe frame slots.
    positions=project(V,bs)
    label_panels=[]
    for i,(x,y,z) in enumerate(positions):
        if not LABELS.active(i,t):continue
        reached=i==0 or flight_progress(i-1,t)>=.999
        col=ACCENT if reached else (171,200,206)
        lx,ly,pw,ph,opacity=LABELS.state(i,t)
        edge=(float(np.clip(x,lx,lx+pw)),float(np.clip(y,ly,ly+ph)))
        if visible(x,y,z):
            leader=Image.new('RGBA',(W,H))
            ImageDraw.Draw(leader).line([(x,y),edge],fill=(*col,round(90*opacity)),width=1)
            im.alpha_composite(leader)
            draw=ImageDraw.Draw(im)
            draw.ellipse((x-6,y-6,x+6,y+6),fill=col)
            draw.ellipse((x-13,y-13,x+13,y+13),outline=(*col,160),width=2)
        panel=split_flap_panel(AIRPORTS[i][0],t-LABELS.appearances[i])
        if (pw,ph)!=(PANEL_W,PANEL_H):
            panel=panel.resize((pw,ph),Image.Resampling.LANCZOS)
        if opacity<1:
            panel.putalpha(panel.getchannel('A').point(lambda value:round(value*opacity)))
        label_panels.append((panel,(lx,ly)))

    # Short arrival pulses punctuate each landing.
    for index,time in enumerate([leg[1] for leg in LEGS], start=1):
        elapsed=t-time
        if 0<=elapsed<1.7:
            x,y,z=positions[index]
            pulse=Image.new('RGBA',(W,H)); pd=ImageDraw.Draw(pulse)
            rr=14+elapsed*29
            pd.ellipse((x-rr,y-rr,x+rr,y+rr),outline=(*ACCENT,int(180*(1-elapsed/1.7))),width=3)
            im=Image.alpha_composite(im,pulse)

    # Route lines, airport dots and arrival pulses are geographic graphics
    # behind the aircraft. Restore its covered scene pixels, including any
    # legitimate cloud/haze obscuration already present in the scene image.
    overlay_crop=im.crop((left,top,left+224,top+224))
    coverage=Image.fromarray(np.rint(alpha[...,0]*255).astype(np.uint8))
    im.paste(Image.composite(aircraft_scene,overlay_crop,coverage),(left,top))
    # Label panels are screen typography, independent of geographic depth.
    # Preserve their lettering even if a custom layout overlaps the aircraft.
    for panel,position in label_panels:
        im.alpha_composite(panel,position)
    if TRIP.telemetry and TRIP.telemetry['enabled']:
        from telemetry_overlay import composite
        im = composite(im, TRIP, t)
    if TRIP.moments:
        from media_overlay import composite as composite_media
        im = composite_media(im, t, WORK)
    return im.convert('RGB')
