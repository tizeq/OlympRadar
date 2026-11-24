"""Official MLH season calendar and NLnet's dated open public call."""
import datetime as dt
from html.parser import HTMLParser
import json
import re
from urllib.parse import urljoin


class MlhPage(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.parts = []
        self.capture = False
        self.feed(html)
        self.close()
        self.props = json.loads(''.join(self.parts))['props']

    def handle_starttag(self, tag, attrs):
        if tag == 'script':
            attributes = dict(attrs)
            self.capture = attributes.get('type') == 'application/json' and attributes.get('data-page') == 'app'

    def handle_data(self, value):
        if self.capture:
            self.parts.append(value)

    def handle_endtag(self, tag):
        if tag == 'script':
            self.capture = False


def mlh(getter):
    home = 'https://www.mlh.com/'
    navigation = MlhPage(getter(home)).props['navigation']['primary']
    seasons = [urljoin(home, child['href']) for group in navigation for child in group.get('children', [])
               if re.fullmatch(r'\d{4} Hackathon Season', child.get('name', ''))]
    season = next((url for url in seasons if re.fullmatch(r'https://www\.mlh\.com/seasons/\d{4}/events/?', url)), None)
    if not season:
        raise ValueError('MLH season link missing')
    items = MlhPage(getter(season.rstrip('/') + '/')).props['upcomingEvents']
    for item in items:
        path = item.get('url') or ''
        if not item.get('name') or not re.fullmatch(r'/events/[a-zA-Z0-9_-]+(?:/prizes)?/?', path):
            continue
        if item.get('status') in ('cancelled', 'ended'):
            continue
        yield {'title': item['name'], 'url': urljoin(home, path), 'source': 'MLH',
               'category': 'hackathon', 'start': item.get('startsAt'), 'end': item.get('endsAt'),
               'country': (item.get('venueAddress') or {}).get('country'),
               'format': {'physical': 'onsite', 'digital': 'online', 'hybrid': 'hybrid'}.get(item.get('formatType')),
               'description': item.get('location')}


class GrantForm(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.heading = None
        self.headings = []
        self.entity = False
        self.individuals = False
        self.links = []
        self.text = []
        self.feed(html)
        self.close()

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == 'h2':
            self.heading = []
        if tag == 'select':
            self.entity = attributes.get('name') == 'entity'
        if self.entity and tag == 'option' and attributes.get('value') == 'Individual':
            self.individuals = True
        if tag == 'a':
            self.links.append(attributes.get('href', ''))

    def handle_endtag(self, tag):
        if tag == 'h2' and self.heading is not None:
            self.headings.append(''.join(self.heading).strip())
            self.heading = None
        if tag == 'select':
            self.entity = False

    def handle_data(self, value):
        if self.heading is not None:
            self.heading.append(value)
        self.text.append(value)


def nlnet(getter):
    form_url = 'https://nlnet.nl/propose/'
    form = GrantForm(getter(form_url))
    if not form.individuals:
        return
    announcement = next((urljoin(form_url, href) for href in form.links
                         if re.fullmatch(r'/news/\d{4}/\d{8}-call\.html', href)), None)
    if not announcement:
        raise ValueError('NLnet dated call announcement missing')
    pattern = r'Next deadline:\s*([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})\s+(\d{1,2}:\d{2})\s+(CET|CEST)\b'
    deadline = next((m for heading in form.headings if (m := re.match(pattern, heading))), None)
    if not deadline:
        raise ValueError('NLnet application cutoff missing')
    month, day, year, clock, zone = deadline.groups()
    local = dt.datetime.strptime(f'{month} {day} {year} {clock}', '%B %d %Y %H:%M')
    cutoff = local.replace(tzinfo=dt.timezone(dt.timedelta(hours=1 if zone == 'CET' else 2)))
    text = ' '.join(' '.join(form.text).split())
    restrictions = ['Форма допускает индивидуальных заявителей. Конкретные требования зависят от фонда.']
    if 'open licences' in text:
        restrictions.append('Для результатов требуются открытые лицензии.')
    if 'European dimension' in text:
        restrictions.append('Для фондов ЕС проект должен иметь европейскую составляющую.')
    yield {'title': f'NLnet — открытый конкурс грантов, приём заявок до {local:%d.%m.%Y}',
           'url': announcement, 'registration_url': form_url, 'source': 'NLnet', 'category': 'grant',
           'deadline': cutoff.isoformat(), 'restrictions': ' '.join(restrictions),
           'description': 'Грантовый конкурс NLnet для технических проектов. Условия программы и форма подачи опубликованы организатором.'}
