---
layout: default
---

<h1> About Me </h1>
{{ site.mydescription }}


Email: [{{ site.email }}](mailto:{{ site.email }})  
My CV is available <a href="{{ site.CV_file }}" target="_blank">here</a>

<!-- ───────────────────────── Job Market Papers ───────────────────────── -->
<section>
  <h2>Job Market Papers</h2>
  {% assign working = site.data.papers | where: "type", "JMP" %}
  {% for p in working %}
    <div class="WP">
      <span class="semi-bold">{{ p.title }}</span>
      {%- if p.authors and p.authors.size > 0 -%}
        <span class="font-small">, with
        {% for a in p.authors %}
          {%- if a.url and a.url != "" -%}
            <a href="{{ a.url }}" class="author" target="_blank">{{ a.name }}</a>
          {%- else -%}
            {{ a.name }}
          {%- endif -%}
          {%- unless forloop.last %} and {% endunless -%}
        {%- endfor -%}
        </span>
      {%- endif %}{% if p.oneline %}&nbsp;{% else %}<br>{% endif %}
      {% if p.detail %}
        <span class="detail">
          {{ p.detail }}
        </span>
      {% endif %}
      <span>
        {% if p.paper %}
          <a href="{{ p.paper }}" class="file" target="_blank">[paper]</a>
        {%- endif %}
        {%- if p.code -%}
          <span class="delimeter">•</span><a href="{{ p.code }}" class="file" target="_blank">[code]</a>
        {%- endif -%}
        {%- if p.online_appendix -%}
          <span class="delimeter">•</span><a href="{{ p.online_appendix }}" class="file" target="_blank">[online appendix]</a>
        {%- endif -%}
	{%- if p.abstract -%}
	    <span class="delimeter">•</span><a href="javascript:void(0);" class="file abstract-toggle">[abstract&nbsp;&nbsp;<span class="chevron-icon"><i class="fas fa-chevron-down"></i></span>]</a>
	{% endif %}
      </span>
      {% if p.abstract %}
        <div class="abstract-content">
          <p>{{ p.abstract }}</p>
        </div>
      {% endif %}
    </div>
  {% endfor %}
</section>

<!-- ───────────────────────── Working Papers ───────────────────────── -->
<section>
  <h2>Working Papers</h2>
  {% assign working = site.data.papers | where: "type", "WP" %}
  {% for p in working %}
    <div class="WP">
      <span class="semi-bold">{{ p.title }}</span>
      {%- if p.authors and p.authors.size > 0 -%}
        <span class="font-small">, with
        {% for a in p.authors %}
          {%- if a.url and a.url != "" -%}
            <a href="{{ a.url }}" class="author" target="_blank">{{ a.name }}</a>
          {%- else -%}
            {{ a.name }}
          {%- endif -%}
          {%- unless forloop.last %} and {% endunless -%}
        {%- endfor -%}
        </span>
      {%- endif %}{% if p.oneline %}&nbsp;{% else %}<br>{% endif %}
      {% if p.detail %}
        <span class="detail">
          {{ p.detail }}
        </span>
      {% endif %}
      <span>
        {% if p.paper %}
          <a href="{{ p.paper }}" class="file" target="_blank">[paper]</a>
        {%- endif %}
        {%- if p.code -%}
          <span class="delimeter">•</span><a href="{{ p.code }}" class="file" target="_blank">[code]</a>
        {%- endif -%}
        {%- if p.online_appendix -%}
          <span class="delimeter">•</span><a href="{{ p.online_appendix }}" class="file" target="_blank">[online appendix]</a>
        {%- endif -%}
	{%- if p.abstract -%}
	    <span class="delimeter">•</span><a href="javascript:void(0);" class="file abstract-toggle">[abstract&nbsp;&nbsp;<span class="chevron-icon"><i class="fas fa-chevron-down"></i></span>]</a>
	{% endif %}
      </span>
      {% if p.abstract %}
        <div class="abstract-content">
          <p>{{ p.abstract }}</p>
        </div>
      {% endif %}
    </div>
  {% endfor %}
</section>

<!-- ───────────────────────── Work in Progress ───────────────────────── -->
<section>
  <h2>Work in Progress</h2>
  {% assign working = site.data.papers | where: "type", "WIP" %}
  {% for p in working %}
    <div class="WIP">
      <span class="semi-bold">{{ p.title }}</span>
      {%- if p.authors and p.authors.size > 0 -%}
        <span class="font-small">, with
        {% for a in p.authors %}
          {%- if a.url and a.url != "" -%}
            <a href="{{ a.url }}" class="author" target="_blank">{{ a.name }}</a>
          {%- else -%}
            {{ a.name }}
          {%- endif -%}
          {%- unless forloop.last %} and {% endunless -%}
        {%- endfor -%}
   	</span>
      {%- endif %}{% if p.oneline %}&nbsp;{% else %}<br>{% endif %}
      {% if p.detail %}
        <span class="detail">
          {{ p.detail }}
        </span>
      {% endif %}
      <span>
        {% if p.paper %}
          <a href="{{ p.paper }}" class="file" target="_blank">[paper]</a>
        {%- endif %}
        {%- if p.code -%}
          <span class="delimeter">•</span><a href="{{ p.code }}" class="file" target="_blank">[code]</a>
        {%- endif -%}
	{%- if p.abstract -%}
	    <a href="javascript:void(0);" class="file abstract-toggle">[abstract&nbsp;&nbsp;<span class="chevron-icon"><i class="fas fa-chevron-down"></i></span>]</a>
	{% endif %}
      </span>
      {% if p.abstract %}
        <div class="abstract-content">
          <p>{{ p.abstract }}</p>
        </div>
      {% endif %}
    </div>
  {% endfor %}
</section>
